use std::sync::Arc;

use bitcoin::secp256k1::PublicKey;
use bitcoin::Network;
use lightning::chain::chainmonitor::ChainMonitor as LdkChainMonitor;
use lightning::chain::{self, BestBlock};
use lightning::events::EventsProvider;
use lightning::ln::channelmanager::{
    Bolt11PaymentError, ChainParameters, ChannelManagerReadArgs, PaymentId, Retry,
};
use lightning::ln::peer_handler::{
    IgnoringMessageHandler, MessageHandler, PeerManager as LdkPeerManager,
};
use lightning::onion_message::messenger::NullMessageRouter;
use lightning::routing::gossip::NetworkGraph;
use lightning::routing::router::RouteParametersConfig;
use lightning::routing::scoring::{
    ProbabilisticScorer, ProbabilisticScoringDecayParameters, ProbabilisticScoringFeeParameters,
};
use lightning::sign::{KeysManager, NodeSigner};
use lightning::util::ser::{ReadableArgs, Writeable};
use wasm_bindgen::JsValue;

use crate::chain::{EsploraBroadcaster, EsploraFeeEstimator};
use crate::config::create_user_config;
use crate::sync::EsploraSyncClient;
use lightning_invoice::Bolt11Invoice;
use lightning_rapid_gossip_sync::RapidGossipSync;

use crate::events::{self, ClaimedPayment, PaymentOutcome};
use crate::io::Clock;
use crate::logger::JsLogger;
use crate::lsps4::client::Lsps4MessageHandler;
use crate::lsps4::msgs::Lsps4Registration;
use crate::persist::DoPersister;
use crate::transport::CfSocketDescriptor;
use crate::types::{ActiveRouter, ChainMonitor, ChannelManager, Graph, PeerManager, Scorer};
use crate::JsLogFn;

/// Monitor persist entry returned in PumpStepResult for JS to write to DO storage.
#[derive(Debug, serde::Serialize)]
pub struct PendingPersistEntry {
    pub key: String,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "updateId")]
    pub update_id: u64,
    /// Hex-encoded full serialized ChannelMonitor bytes.
    pub data: String,
}

impl From<crate::persist::PendingMonitorPersist> for PendingPersistEntry {
    fn from(w: crate::persist::PendingMonitorPersist) -> Self {
        Self {
            key: w.key,
            channel_id: hex::encode(w.channel_id.0),
            update_id: w.update_id,
            data: hex::encode(&w.data),
        }
    }
}

/// Result from one iteration of the sync pump loop.
///
/// Returned by `EphemeralNode::process_pump_step()`. JS reads these fields
/// to decide what to do next (write outbound, check registration, etc.).
#[derive(Debug, serde::Serialize)]
pub struct PumpStepResult {
    /// Outbound bytes to write to the TCP socket (hex-encoded for JS).
    #[serde(rename = "outbound")]
    pub outbound_hex: String,
    /// True if the LN peer handshake + Init exchange is complete.
    #[serde(rename = "peerReady")]
    pub peer_ready: bool,
    /// True if at least one channel is usable (channel_reestablish complete).
    #[serde(rename = "channelsReady")]
    pub channels_ready: bool,
    /// LSPS4 registration response, if received this step.
    pub registration: Option<PumpRegistration>,
    /// LSPS4 registration error, if received this step.
    #[serde(rename = "registrationError")]
    pub registration_error: Option<String>,
    /// Payments claimed during this step.
    #[serde(rename = "claimedPayments")]
    pub claimed_payments: Vec<ClaimedPayment>,
    /// Outbound payment outcome, if resolved this step.
    #[serde(rename = "paymentOutcome")]
    pub payment_outcome: Option<PumpPaymentOutcome>,
    /// True if the peer disconnected.
    pub disconnected: bool,
    /// Sweepable output bytes collected during this step (not serialized to JS).
    #[serde(skip)]
    pub sweepable_outputs: Vec<Vec<u8>>,
    /// Monitor writes pending DO storage persistence.
    #[serde(rename = "pendingPersists")]
    pub pending_persists: Vec<PendingPersistEntry>,
    /// Monitor keys to delete from DO storage.
    #[serde(rename = "pendingDeletes")]
    pub pending_deletes: Vec<String>,
}

/// LSPS4 registration data returned in PumpStepResult.
#[derive(Debug, serde::Serialize)]
pub struct PumpRegistration {
    /// Serialized as string to avoid f64 precision loss when crossing the WASM<->JS boundary.
    /// SCIDs are u64 values that exceed Number.MAX_SAFE_INTEGER (2^53).
    #[serde(rename = "interceptScid", serialize_with = "serialize_u64_as_string")]
    pub intercept_scid: u64,
    #[serde(rename = "cltvExpiryDelta")]
    pub cltv_expiry_delta: u32,
}

fn serialize_u64_as_string<S: serde::Serializer>(val: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&val.to_string())
}

/// Payment outcome in PumpStepResult.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "type")]
pub enum PumpPaymentOutcome {
    #[serde(rename = "sent")]
    Sent {
        #[serde(rename = "paymentHash")]
        payment_hash: String,
        preimage: String,
        #[serde(rename = "amountMsat")]
        amount_msat: Option<u64>,
        #[serde(rename = "feePaidMsat")]
        fee_paid_msat: Option<u64>,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(rename = "paymentHash")]
        payment_hash: String,
        reason: String,
    },
}

/// An ephemeral Lightning node that restores from persisted state,
/// processes pending work, and shuts down.
pub struct EphemeralNode {
    channel_manager: Arc<ChannelManager>,
    chain_monitor: Arc<ChainMonitor>,
    peer_manager: Arc<PeerManager>,
    keys_manager: Arc<KeysManager>,
    persister: Arc<DoPersister>,
    #[allow(dead_code)]
    fee_estimator: Arc<EsploraFeeEstimator>,
    #[allow(dead_code)]
    broadcaster: Arc<EsploraBroadcaster>,
    network_graph: Arc<Graph>,
    #[allow(dead_code)]
    scorer: Arc<std::cell::RefCell<Scorer>>,
    #[allow(dead_code)]
    router: Arc<ActiveRouter>,
    #[allow(dead_code)]
    logger: Arc<JsLogger>,
    tx_sync: Arc<EsploraSyncClient<Arc<JsLogger>>>,
    lsps4_handler: Arc<Lsps4MessageHandler>,
    #[allow(dead_code)]
    esplora_url: String,
    network: Network,
    clock: Box<dyn Clock>,
}

impl EphemeralNode {
    /// Build the node from raw bytes (provided by JS from DO storage).
    /// No I/O, no async, no storage backend dependencies.
    pub fn restore_from_bytes(
        monitor_bytes_list: &[&[u8]],
        monitor_keys: &[String],
        cm_bytes: Option<&[u8]>,
        fee_json: &[u8],
        mnemonic: &str,
        network: Network,
        esplora_url: String,
        log_fn: Option<JsLogFn>,
        clock: Box<dyn Clock>,
    ) -> Result<Self, JsValue> {
        let logger = Arc::new(JsLogger::new(log_fn));
        let fee_estimator = Arc::new(EsploraFeeEstimator::new());
        let broadcaster = Arc::new(EsploraBroadcaster::new());
        let lsps4_handler = Arc::new(Lsps4MessageHandler::new());

        // Populate fee cache from pre-fetched JSON (sync)
        fee_estimator
            .populate_from_json(fee_json)
            .map_err(|e| JsValue::from_str(&e))?;

        // Derive seed from mnemonic (sync)
        let seed = crate::mnemonic_to_seed(mnemonic)?;
        let now = clock.now_millis() as u64;
        let mut time_entropy = [0u8; 12];
        getrandom::getrandom(&mut time_entropy).expect("getrandom failed");
        let starting_time_secs = u64::from_be_bytes(time_entropy[..8].try_into().unwrap());
        let starting_time_nanos = u32::from_be_bytes(time_entropy[8..12].try_into().unwrap());
        let keys_manager = Arc::new(KeysManager::new(
            &seed,
            starting_time_secs,
            starting_time_nanos,
            false,
        ));

        // Create DoPersister (pure in-memory buffer, no external dependencies)
        let persister = Arc::new(DoPersister::new());

        // Deserialize monitors (sync)
        let mut channel_monitors = Vec::new();
        for bytes in monitor_bytes_list {
            let mut reader = lightning::io::Cursor::new(*bytes);
            let (_block_hash, monitor) = <(
                bitcoin::BlockHash,
                lightning::chain::channelmonitor::ChannelMonitor<lightning::sign::InMemorySigner>,
            )>::read(
                &mut reader, (&*keys_manager, &*keys_manager)
            )
            .map_err(|e| JsValue::from_str(&format!("Monitor decode failed: {:?}", e)))?;
            channel_monitors.push(monitor);
        }

        // Build all LDK types (sync)
        let network_graph = Arc::new(NetworkGraph::new(network, logger.clone()));
        let scorer = Arc::new(std::cell::RefCell::new(ProbabilisticScorer::new(
            ProbabilisticScoringDecayParameters::default(),
            network_graph.clone(),
            logger.clone(),
        )));
        let router = Arc::new(lightning::routing::router::DefaultRouter::new(
            network_graph.clone(),
            logger.clone(),
            keys_manager.clone(),
            scorer.clone(),
            ProbabilisticScoringFeeParameters::default(),
        ));
        let peer_storage_key = keys_manager.get_peer_storage_key();
        let tx_sync = Arc::new(EsploraSyncClient::new(esplora_url.clone(), logger.clone()));
        let chain_monitor: Arc<ChainMonitor> = Arc::new(LdkChainMonitor::new(
            Some(tx_sync.clone() as Arc<dyn chain::Filter + Send + Sync>),
            broadcaster.clone(),
            logger.clone(),
            fee_estimator.clone(),
            persister.clone(),
            keys_manager.clone(),
            peer_storage_key,
        ));

        // Restore or create ChannelManager (sync)
        let channel_manager = match cm_bytes {
            Some(bytes) => {
                let monitor_refs: Vec<
                    &lightning::chain::channelmonitor::ChannelMonitor<
                        lightning::sign::InMemorySigner,
                    >,
                > = channel_monitors.iter().collect();
                let read_args = ChannelManagerReadArgs::new(
                    keys_manager.clone(),
                    keys_manager.clone(),
                    keys_manager.clone(),
                    fee_estimator.clone(),
                    chain_monitor.clone(),
                    broadcaster.clone(),
                    router.clone(),
                    Arc::new(NullMessageRouter {}),
                    logger.clone(),
                    create_user_config(),
                    monitor_refs,
                );
                let mut reader = lightning::io::Cursor::new(bytes);
                let (_block_hash, cm) =
                    <(bitcoin::BlockHash, ChannelManager)>::read(&mut reader, read_args)
                        .map_err(|e| JsValue::from_str(&format!("CM decode failed: {:?}", e)))?;
                Arc::new(cm)
            }
            None => Self::create_fresh_channel_manager(
                &keys_manager,
                &fee_estimator,
                &chain_monitor,
                &broadcaster,
                &router,
                &logger,
                network,
                &*clock,
            ),
        };

        // Register restored monitors with ChainMonitor and populate crash recovery key map.
        // Uses load_existing_monitor() instead of watch_channel() because these
        // monitors are already persisted. watch_channel() would trigger a
        // redundant persist_new_channel() call, queuing unnecessary writes.
        if channel_monitors.len() != monitor_keys.len() {
            return Err(JsValue::from_str(&format!(
                "monitor_bytes_list length ({}) != monitor_keys length ({})",
                channel_monitors.len(),
                monitor_keys.len()
            )));
        }
        for (i, monitor) in channel_monitors.into_iter().enumerate() {
            let channel_id = monitor.channel_id();
            persister.register_channel_key(channel_id, monitor_keys[i].clone());
            persister
                .register_monitor_name_key(&monitor.persistence_key(), monitor_keys[i].clone());
            chain_monitor
                .load_existing_monitor(channel_id, monitor)
                .map_err(|_| JsValue::from_str("Failed to load existing monitor"))?;
        }

        // Build PeerManager
        // send_only_message_handler is ChainMonitor so it can send PeerStorage
        // messages, matching ldk-node's setup.
        let peer_manager = Arc::new(LdkPeerManager::new(
            MessageHandler {
                chan_handler: channel_manager.clone(),
                route_handler: Arc::new(IgnoringMessageHandler {}),
                onion_message_handler: Arc::new(IgnoringMessageHandler {}),
                custom_message_handler: lsps4_handler.clone(),
                send_only_message_handler: chain_monitor.clone(),
            },
            (now / 1000) as u32,
            &seed,
            logger.clone(),
            keys_manager.clone(),
        ));

        Ok(Self {
            channel_manager,
            chain_monitor,
            peer_manager,
            keys_manager,
            persister,
            fee_estimator,
            broadcaster,
            network_graph,
            scorer,
            router,
            logger,
            tx_sync,
            lsps4_handler,
            esplora_url,
            network,
            clock,
        })
    }

    fn create_fresh_channel_manager(
        keys_manager: &Arc<KeysManager>,
        fee_estimator: &Arc<EsploraFeeEstimator>,
        chain_monitor: &Arc<ChainMonitor>,
        broadcaster: &Arc<EsploraBroadcaster>,
        router: &Arc<ActiveRouter>,
        logger: &Arc<JsLogger>,
        network: Network,
        clock: &dyn Clock,
    ) -> Arc<ChannelManager> {
        let best_block = BestBlock::new(
            bitcoin::blockdata::constants::genesis_block(network)
                .header
                .block_hash(),
            0,
        );
        Arc::new(ChannelManager::new(
            fee_estimator.clone(),
            chain_monitor.clone(),
            broadcaster.clone(),
            router.clone(),
            Arc::new(NullMessageRouter {}),
            logger.clone(),
            keys_manager.clone(),
            keys_manager.clone(),
            keys_manager.clone(),
            create_user_config(),
            ChainParameters {
                network,
                best_block,
            },
            clock.now_secs_u32(),
        ))
    }

    /// Build a BOLT11 invoice with JIT route hint via the LSP.
    pub(crate) fn build_invoice(
        &self,
        lsp_pubkey: PublicKey,
        intercept_scid: u64,
        cltv_expiry_delta: u32,
        amount_sats: Option<u64>,
        description: &str,
        expiry_secs: u32,
    ) -> Result<lightning_invoice::Bolt11Invoice, JsValue> {
        let currency = network_to_currency(self.network);
        let now_epoch_secs = self.clock.now_secs();

        crate::lsps4::invoice::create_jit_invoice(
            &self.channel_manager,
            &self.keys_manager,
            lsp_pubkey,
            intercept_scid,
            cltv_expiry_delta as u16,
            amount_sats,
            description,
            expiry_secs,
            currency,
            now_epoch_secs,
        )
        .map_err(|e| JsValue::from_str(&e))
    }

    /// Process pending events from the ChainMonitor (SpendableOutputs, etc.).
    fn process_chain_monitor_events(&self, sweepable_outputs: &mut Vec<Vec<u8>>) {
        let sweep_cell = std::cell::RefCell::new(sweepable_outputs);
        self.chain_monitor
            .process_pending_events(
                &|event: lightning::events::Event| -> Result<(), lightning::events::ReplayEvent> {
                    if let lightning::events::Event::SpendableOutputs { outputs, .. } = event {
                        let mut sweep = sweep_cell.borrow_mut();
                        for output in outputs {
                            let mut bytes = Vec::new();
                            output
                                .write(&mut bytes)
                                .expect("in-memory serialization cannot fail");
                            sweep.push(bytes);
                        }
                    }
                    Ok(())
                },
            );
    }

    /// Return a reference to the node's clock.
    pub fn clock(&self) -> &dyn Clock {
        &*self.clock
    }

    // ── JS-driven pump loop support ─────────────────────────────────────────
    //
    // These methods support the restructured architecture where the async event
    // loop runs in JavaScript and WASM is called synchronously for message
    // processing. This mirrors lightning-net-tokio's design: the async runtime
    // (JS) handles I/O, and LDK does synchronous message processing.

    /// Initiate a BOLT 8 outbound connection to the LSP.
    ///
    /// Creates a CfSocketDescriptor and generates the initial handshake bytes.
    /// Returns (descriptor, handshake_bytes). JS must write the handshake bytes
    /// to the TCP socket, then enter the pump loop.
    pub fn initiate_outbound_connection(
        &self,
        lsp_pubkey: PublicKey,
    ) -> Result<(CfSocketDescriptor, Vec<u8>), String> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let descriptor =
            CfSocketDescriptor::new(NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let handshake = self
            .peer_manager
            .new_outbound_connection(lsp_pubkey, descriptor.clone(), None)
            .map_err(|e| format!("Outbound connection failed: {:?}", e))?;

        // Buffer the handshake into the descriptor, then drain it for JS to write
        descriptor.buffer_write(&handshake);
        let outbound = descriptor.take_buffered();

        Ok((descriptor, outbound))
    }

    /// Queue an LSPS4 register_node request to the given LSP.
    pub fn queue_lsps4_register(&self, lsp_pubkey: PublicKey) {
        self.lsps4_handler.send_register_node(lsp_pubkey);
    }

    /// Process one iteration of the pump loop synchronously.
    ///
    /// Feeds inbound bytes to PeerManager, processes events, and returns
    /// a result struct with outbound bytes and status flags. JS calls this
    /// from its async read/write loop.
    pub fn process_pump_step(
        &self,
        descriptor: &mut CfSocketDescriptor,
        inbound: &[u8],
        lsp_pubkey: Option<PublicKey>,
    ) -> Result<PumpStepResult, String> {
        // 1. Feed inbound bytes to PeerManager in 4KiB chunks.
        // LDK recommends ~4KiB per read_event call to avoid processing too many
        // messages at once. We call process_events() between chunks so outbound
        // responses are queued promptly (matches lightning-net-tokio's pattern).
        if !inbound.is_empty() {
            for chunk in inbound.chunks(4096) {
                self.peer_manager
                    .read_event(descriptor, chunk)
                    .map_err(|e| format!("read_event failed: {:?}", e))?;
                self.peer_manager.process_events();
            }
        }

        // 2. Process peer events (handles any remaining outbound after final chunk)
        self.peer_manager.process_events();

        // 3. Forward pending HTLCs internally
        self.channel_manager.process_pending_htlc_forwards();

        // 4. Process LDK events (claims, channel opens, payments, etc.)
        let mut sweepable_outputs = Vec::new();
        let (claimed, outcomes) =
            events::process_events(&self.channel_manager, lsp_pubkey, &mut sweepable_outputs);

        // 5. Process ChainMonitor events (SpendableOutputs)
        self.process_chain_monitor_events(&mut sweepable_outputs);

        // 6. Second round of process_events to flush messages generated by event handling
        self.peer_manager.process_events();

        // 7. Drain pending monitor writes for JS to persist to DO storage
        let pending_persist_entries: Vec<PendingPersistEntry> = self
            .persister
            .take_pending()
            .into_iter()
            .map(PendingPersistEntry::from)
            .collect();
        let pending_delete_keys = self.persister.take_pending_deletes();

        // 8. Collect outbound bytes
        let outbound = descriptor.take_buffered();

        // 9. Check peer readiness and channel usability
        let peer_ready = lsp_pubkey
            .map(|pk| self.peer_manager.peer_by_node_id(&pk).is_some())
            .unwrap_or(false);
        let channels_ready = !self.channel_manager.list_usable_channels().is_empty();

        // 10. Check LSPS4 registration
        let (registration, registration_error) = match self.lsps4_handler.take_registration() {
            Some(Ok(r)) => (
                Some(PumpRegistration {
                    intercept_scid: r.intercept_scid,
                    cltv_expiry_delta: r.cltv_expiry_delta,
                }),
                None,
            ),
            Some(Err(e)) => (None, Some(e)),
            None => (None, None),
        };

        // 11. Convert payment outcomes
        let payment_outcome = outcomes.into_iter().next().map(|o| match o {
            PaymentOutcome::Sent(s) => PumpPaymentOutcome::Sent {
                payment_hash: s.payment_hash,
                preimage: s.preimage,
                amount_msat: s.amount_msat,
                fee_paid_msat: s.fee_paid_msat,
            },
            PaymentOutcome::Failed {
                payment_hash,
                reason,
            } => PumpPaymentOutcome::Failed {
                payment_hash,
                reason,
            },
        });

        Ok(PumpStepResult {
            outbound_hex: if outbound.is_empty() {
                String::new()
            } else {
                hex::encode(&outbound)
            },
            peer_ready,
            channels_ready,
            registration,
            registration_error,
            claimed_payments: claimed,
            payment_outcome,
            disconnected: descriptor.is_disconnected(),
            sweepable_outputs,
            pending_persists: pending_persist_entries,
            pending_deletes: pending_delete_keys,
        })
    }

    /// Run startup calls for the claiming pump loop.
    ///
    /// Must be called once before entering the JS pump loop for payment claiming.
    /// Mirrors BackgroundProcessor's initialization.
    pub fn prepare_for_claiming(&self) {
        self.timer_tick();
        self.chain_monitor.rebroadcast_pending_claims();
    }

    /// Lightweight timer ticks without rebroadcasting.
    /// Used by receivePayments and pay instead of the full prepare_for_claiming.
    pub fn timer_tick(&self) {
        self.channel_manager.timer_tick_occurred();
        self.peer_manager.timer_tick_occurred();
    }

    /// Disconnect all peers (no socket needed — JS closes the socket separately).
    pub fn disconnect_all(&self) {
        self.peer_manager.disconnect_all_peers();
    }

    /// Return a reference to the PeerManager.
    pub fn peer_manager(&self) -> &PeerManager {
        &self.peer_manager
    }

    /// Flush any pending broadcast transactions to Esplora.
    /// Must be called from an async context (JS side) before teardown.
    pub async fn flush_broadcasts(&self, fetcher: &impl crate::io::Fetcher) {
        self.broadcaster
            .flush(fetcher, &self.esplora_url, &self.logger)
            .await;
    }

    /// Return a cloned Arc to the EsploraSyncClient.
    pub fn tx_sync(&self) -> Arc<EsploraSyncClient<Arc<JsLogger>>> {
        self.tx_sync.clone()
    }

    /// Return a cloned Arc to the ChannelManager.
    pub fn channel_manager_ref(&self) -> Arc<ChannelManager> {
        self.channel_manager.clone()
    }

    /// Return a cloned Arc to the ChainMonitor.
    pub fn chain_monitor_ref(&self) -> Arc<ChainMonitor> {
        self.chain_monitor.clone()
    }

    /// Return a cloned Arc to the DoPersister.
    pub fn persister_ref(&self) -> Arc<DoPersister> {
        self.persister.clone()
    }

    /// Return a cloned Arc to the EsploraBroadcaster.
    pub fn broadcaster_ref(&self) -> Arc<EsploraBroadcaster> {
        self.broadcaster.clone()
    }

    /// Return the Esplora URL.
    pub fn esplora_url_ref(&self) -> &str {
        &self.esplora_url
    }

    /// Return a cloned Arc to the logger.
    pub fn logger_ref(&self) -> Arc<JsLogger> {
        self.logger.clone()
    }

    /// Initiate an outbound payment for a BOLT11 invoice.
    /// Applies the RGS snapshot to the network graph, parses the invoice,
    /// and calls pay_for_bolt11_invoice. Returns (payment_hash_hex, rgs_timestamp).
    pub fn initiate_payment(&self, rgs_data: &[u8], bolt11: &str) -> Result<(String, u32), String> {
        let rgs = RapidGossipSync::new(self.network_graph.clone(), self.logger.clone());
        let now_secs = self.clock.now_secs();
        let rgs_timestamp = rgs
            .update_network_graph_no_std(rgs_data, Some(now_secs))
            .map_err(|e| format!("RGS sync failed: {:?}", e))?;

        let invoice: Bolt11Invoice = bolt11
            .parse::<Bolt11Invoice>()
            .map_err(|e| format!("Invoice parse failed: {:?}", e))?;

        let hash_bytes: &[u8; 32] = invoice.payment_hash().as_ref();
        let payment_id = PaymentId(*hash_bytes);
        self.channel_manager
            .pay_for_bolt11_invoice(
                &invoice,
                payment_id,
                None,
                RouteParametersConfig::default(),
                Retry::Attempts(3),
            )
            .map_err(|e| match e {
                Bolt11PaymentError::InvalidAmount => "Invalid invoice amount".to_string(),
                Bolt11PaymentError::SendingFailed(e) => format!("Sending failed: {:?}", e),
            })?;

        Ok((hex::encode(hash_bytes), rgs_timestamp))
    }

    /// Return the node's public key as a hex string.
    pub fn node_id(&self) -> String {
        self.channel_manager.get_our_node_id().to_string()
    }

    /// Get node info with channel balances.
    pub fn get_info(&self) -> events::NodeInfo {
        let channels = self.channel_manager.list_channels();
        let channel_infos: Vec<events::ChannelInfo> = channels
            .iter()
            .map(|ch| {
                let balance_msat = ch.outbound_capacity_msat;
                events::ChannelInfo {
                    channel_id: hex::encode(ch.channel_id.0),
                    counterparty_node_id: ch.counterparty.node_id.to_string(),
                    channel_value_sats: ch.channel_value_satoshis,
                    balance_msat,
                    outbound_capacity_msat: ch.outbound_capacity_msat,
                    inbound_capacity_msat: ch.inbound_capacity_msat,
                    is_usable: ch.is_usable,
                    is_channel_ready: ch.is_channel_ready,
                }
            })
            .collect();
        let total_balance_msat = channel_infos.iter().map(|c| c.balance_msat).sum();
        let total_inbound_capacity_msat =
            channel_infos.iter().map(|c| c.inbound_capacity_msat).sum();
        events::NodeInfo {
            node_id: self.node_id(),
            num_channels: channel_infos.len(),
            total_balance_msat,
            total_inbound_capacity_msat,
            channels: channel_infos,
        }
    }
}

/// Invoice details returned for MDK checkout registration.
#[derive(Debug, serde::Serialize)]
pub struct InvoiceDetails {
    pub invoice: String,
    #[serde(rename = "paymentHash")]
    pub payment_hash: String,
    pub scid: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

impl InvoiceDetails {
    pub fn from_invoice(
        invoice: &Bolt11Invoice,
        registration: &Lsps4Registration,
        expiry_secs: u32,
        clock: &dyn Clock,
    ) -> Self {
        let payment_hash = hex::encode(invoice.payment_hash().as_ref() as &[u8]);
        let scid = registration.intercept_scid;
        let scid_str = format!(
            "{}x{}x{}",
            scid >> 40,
            (scid >> 16) & 0xFFFFFF,
            scid & 0xFFFF
        );
        let now = clock.now_secs();
        InvoiceDetails {
            invoice: invoice.to_string(),
            payment_hash,
            scid: scid_str,
            expires_at: now + expiry_secs as u64,
        }
    }
}

/// Convert Bitcoin network to lightning-invoice currency.
fn network_to_currency(network: Network) -> lightning_invoice::Currency {
    match network {
        Network::Bitcoin => lightning_invoice::Currency::Bitcoin,
        Network::Testnet => lightning_invoice::Currency::BitcoinTestnet,
        Network::Regtest => lightning_invoice::Currency::Regtest,
        _ => lightning_invoice::Currency::Signet,
    }
}
