use bitcoin::secp256k1::PublicKey;
use bitcoin::Network;
use lightning::ln::types::ChannelId;
use lightning::sign::{KeysManager, NodeSigner};
use wasm_bindgen::prelude::*;

pub mod chain;
pub mod config;
pub mod events;
pub mod io;
pub mod logger;
pub mod lsps4;
pub mod node;
pub mod persist;
pub mod sync;
pub mod transport;
pub mod types;

#[cfg(test)]
mod testutil;

// JS-provided I/O interfaces (duck-typed via wasm_bindgen structural)

#[wasm_bindgen]
extern "C" {
    /// HTTP client — wraps global fetch()
    pub type JsFetcher;

    #[wasm_bindgen(structural, method, catch)]
    pub async fn get_json(this: &JsFetcher, url: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, catch)]
    pub async fn get_text(this: &JsFetcher, url: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, catch)]
    pub async fn post_bytes(this: &JsFetcher, url: &str, body: &[u8]) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(structural, method, catch)]
    pub async fn get_bytes(this: &JsFetcher, url: &str) -> Result<JsValue, JsValue>;

    /// Logging callback
    pub type JsLogFn;

    #[wasm_bindgen(structural, method)]
    pub fn log(this: &JsLogFn, level: &str, msg: &str);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn parse_network(network: &str) -> Result<Network, JsValue> {
    match network {
        "bitcoin" | "mainnet" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        "regtest" => Ok(Network::Regtest),
        "signet" => Ok(Network::Signet),
        _ => Err(JsValue::from_str(&format!("Unknown network: {}", network))),
    }
}

fn parse_pubkey(hex: &str) -> Result<PublicKey, JsValue> {
    hex.parse::<PublicKey>()
        .map_err(|e| JsValue::from_str(&format!("Invalid pubkey: {}", e)))
}

/// Parse a BIP-39 mnemonic and return the first 32 bytes of the seed.
pub(crate) fn mnemonic_to_seed(mnemonic: &str) -> Result<[u8; 32], JsValue> {
    let parsed = bip39::Mnemonic::parse(mnemonic)
        .map_err(|e| JsValue::from_str(&format!("Invalid mnemonic: {}", e)))?;
    let seed_bytes = parsed.to_seed("");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes[..32]);
    Ok(seed)
}

use crate::io::{JsClock, JsFetcherImpl};

// ── WASM Exports ─────────────────────────────────────────────────────────────

/// Derive the Lightning node ID (public key hex) from a BIP-39 mnemonic.
/// Stateless — no store or network needed.
#[wasm_bindgen]
pub fn derive_node_id(mnemonic: &str, network: &str) -> Result<String, JsValue> {
    let _network = parse_network(network)?;

    let seed = mnemonic_to_seed(mnemonic)?;

    let keys_manager = KeysManager::new(&seed, 0, 0, false);
    let node_id = keys_manager
        .get_node_id(lightning::sign::Recipient::Node)
        .map_err(|_| JsValue::from_str("Failed to derive node ID"))?;

    Ok(node_id.to_string())
}

// ── Session-based sync WASM exports ─────────────────────────────────────────
//
// These exports support the architecture where the async event loop runs in
// JavaScript and WASM is called only synchronously. This eliminates large
// WASM async state machines that trigger CF Workers' "hung worker" detection
// (error 1101).
//
// Usage from JS:
//   1. setup_node(monitors, cm, fees)  → sync (builds node, stores in thread_local)
//   2. initiate_connection(pubkey)     → sync (returns handshake bytes)
//   3. JS pump loop:
//      a. await socket.write(handshake)
//      b. loop { bytes = await socket.read(); result = process_peer_message(bytes); ... }
//      c. flush pendingPersists to DO storage, signal_monitors_persisted()
//   4. create_invoice_on_session()     → sync (builds invoice from SCID)
//   5. teardown_node()                 → sync (disconnects, drops node)
//   6. JS persists CM + sweepable outputs via needs_persistence() + serialize_channel_manager()

use crate::transport::CfSocketDescriptor;
use std::cell::RefCell;
use std::sync::Arc;

struct NodeSession {
    node: node::EphemeralNode,
    descriptor: Option<CfSocketDescriptor>,
    lsp_pubkey: Option<bitcoin::secp256k1::PublicKey>,
    sweepable_outputs: Vec<Vec<u8>>,
    persister: Arc<crate::persist::DoPersister>,
    chain_monitor: Arc<crate::types::ChainMonitor>,
}

thread_local! {
    // Safe: WASM is single-threaded. CF Workers guarantee one request per isolate.
    static SESSION: RefCell<Option<NodeSession>> = RefCell::new(None);
}

/// Build node from raw bytes (provided by JS from DO storage) and store in
/// thread_local session. Fully synchronous.
#[wasm_bindgen]
pub fn setup_node(
    monitor_entries_json: &str,
    cm_bytes: Option<Vec<u8>>,
    fee_json: &str,
    mnemonic: &str,
    network: &str,
    esplora_url: &str,
) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    #[derive(serde::Deserialize)]
    struct MonitorEntry {
        key: String,
        data: Vec<u8>,
    }

    let monitor_entries: Vec<MonitorEntry> = serde_json::from_str(monitor_entries_json)
        .map_err(|e| JsValue::from_str(&format!("Deserialize monitor entries failed: {}", e)))?;

    let monitor_bytes_refs: Vec<&[u8]> =
        monitor_entries.iter().map(|e| e.data.as_slice()).collect();
    let monitor_keys: Vec<String> = monitor_entries.iter().map(|e| e.key.clone()).collect();
    let network = parse_network(network)?;

    let node = node::EphemeralNode::restore_from_bytes(
        &monitor_bytes_refs,
        &monitor_keys,
        cm_bytes.as_deref(),
        fee_json.as_bytes(),
        mnemonic,
        network,
        esplora_url.to_string(),
        None,
        Box::new(JsClock),
    )?;

    let persister = node.persister_ref();
    let chain_monitor = node.chain_monitor_ref();

    SESSION.with(|s| {
        *s.borrow_mut() = Some(NodeSession {
            node,
            descriptor: None,
            lsp_pubkey: None,
            sweepable_outputs: Vec::new(),
            persister,
            chain_monitor,
        });
    });

    Ok(())
}

/// Initiate BOLT 8 outbound connection to LSP.
/// Returns the initial handshake bytes (hex-encoded) that JS must write to the socket.
#[wasm_bindgen]
pub fn initiate_connection(lsp_pubkey: &str) -> Result<String, JsValue> {
    let pubkey = parse_pubkey(lsp_pubkey)?;

    SESSION.with(|s| {
        let mut borrow = s.borrow_mut();
        let session = borrow
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active session — call setup_node first"))?;

        let (descriptor, handshake_bytes) = session
            .node
            .initiate_outbound_connection(pubkey)
            .map_err(|e| JsValue::from_str(&e))?;

        session.descriptor = Some(descriptor);
        session.lsp_pubkey = Some(pubkey);

        Ok(hex::encode(&handshake_bytes))
    })
}

/// Process inbound TCP bytes through the LDK PeerManager. Fully synchronous.
///
/// Returns JSON: { outbound, peerReady, registration?, claimedPayments, paymentOutcome?,
///                 disconnected, pendingPersists, pendingDeletes }
/// JS reads `outbound` (hex) and writes it to the socket, then checks status fields.
#[wasm_bindgen]
pub fn process_peer_message(inbound: &[u8]) -> Result<String, JsValue> {
    SESSION.with(|s| {
        let mut borrow = s.borrow_mut();
        let session = borrow
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let descriptor = session.descriptor.as_mut().ok_or_else(|| {
            JsValue::from_str("No active connection — call initiate_connection first")
        })?;

        let result = session
            .node
            .process_pump_step(descriptor, inbound, session.lsp_pubkey)
            .map_err(|e| JsValue::from_str(&e))?;

        if !result.sweepable_outputs.is_empty() {
            session
                .sweepable_outputs
                .extend(result.sweepable_outputs.iter().cloned());
        }

        serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialize PumpStepResult failed: {}", e)))
    })
}

/// Queue an LSPS4 register_node request to the connected LSP.
/// Call this after process_peer_message returns peerReady=true.
#[wasm_bindgen]
pub fn queue_lsps4_register() -> Result<(), JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        let pubkey = session
            .lsp_pubkey
            .ok_or_else(|| JsValue::from_str("No LSP pubkey — call initiate_connection first"))?;

        session.node.queue_lsps4_register(pubkey);
        Ok(())
    })
}

/// Create a BOLT11 invoice on the active session node using LSPS4 registration data.
///
/// Returns JSON: { invoice, paymentHash, scid, expiresAt }
#[wasm_bindgen]
pub fn create_invoice_on_session(
    lsp_pubkey: &str,
    intercept_scid: &str, // String to avoid f64 precision loss (SCIDs exceed 2^53)
    cltv_expiry_delta: u32,
    amount_sats: Option<u64>,
    description: &str,
    expiry_secs: u32,
) -> Result<String, JsValue> {
    let lsp_pubkey = parse_pubkey(lsp_pubkey)?;
    // Support both NxNxN format (from MDK API) and raw u64 (from LSPS4 registration)
    let scid: u64 = if intercept_scid.contains('x') {
        crate::lsps4::msgs::parse_scid(intercept_scid).map_err(|e| JsValue::from_str(&e))?
    } else {
        intercept_scid
            .parse()
            .map_err(|e| JsValue::from_str(&format!("Invalid intercept_scid: {}", e)))?
    };

    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let registration = crate::lsps4::msgs::Lsps4Registration {
            intercept_scid: scid,
            cltv_expiry_delta,
        };

        let invoice = session.node.build_invoice(
            lsp_pubkey,
            registration.intercept_scid,
            registration.cltv_expiry_delta,
            amount_sats,
            description,
            expiry_secs,
        )?;

        let details = node::InvoiceDetails::from_invoice(
            &invoice,
            &registration,
            expiry_secs,
            session.node.clock(),
        );

        serde_json::to_string(&details)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// Run startup calls for payment claiming (timer ticks, rebroadcast).
/// Call once before entering the JS pump loop for receivePayments.
#[wasm_bindgen]
pub fn prepare_for_claiming() -> Result<(), JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        session.node.prepare_for_claiming();
        Ok(())
    })
}

/// Lightweight timer ticks for ChannelManager and PeerManager.
/// Used by receivePayments and pay instead of the full prepare_for_claiming
/// (which also rebroadcasts — moved to the periodic alarm).
#[wasm_bindgen]
pub fn timer_tick() -> Result<(), JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        session.node.timer_tick();
        Ok(())
    })
}

/// Apply an RGS snapshot and initiate an outbound BOLT11 payment on the active session.
/// Returns JSON: { paymentHash: "<hex>", rgsTimestamp: <u32> }
#[wasm_bindgen]
pub fn prepare_for_sending(rgs_data: &[u8], bolt11: &str) -> Result<String, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let (payment_hash, rgs_timestamp) = session
            .node
            .initiate_payment(rgs_data, bolt11)
            .map_err(|e| JsValue::from_str(&e))?;

        let result =
            serde_json::json!({ "paymentHash": payment_hash, "rgsTimestamp": rgs_timestamp });
        serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// Notify PeerManager that the socket was closed by the remote peer.
/// Clears the stored descriptor so subsequent calls know the connection is gone.
#[wasm_bindgen]
pub fn notify_socket_disconnected() -> Result<(), JsValue> {
    SESSION.with(|s| {
        let mut borrow = s.borrow_mut();
        let session = borrow
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        if let Some(ref descriptor) = session.descriptor {
            session.node.peer_manager().socket_disconnected(descriptor);
            session.node.peer_manager().process_events();
        }
        session.descriptor = None;
        Ok(())
    })
}

/// Flush any pending broadcast transactions (justice txs, HTLC-timeout txs) to Esplora.
/// Call before teardown to ensure LDK-queued transactions are actually broadcast.
#[wasm_bindgen]
pub async fn flush_broadcasts_on_session(fetcher: &JsFetcher) -> Result<(), JsValue> {
    let f = JsFetcherImpl::new(fetcher);

    let (broadcaster, esplora_url, logger) = SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        Ok::<_, JsValue>((
            session.node.broadcaster_ref(),
            session.node.esplora_url_ref().to_string(),
            session.node.logger_ref(),
        ))
    })?;

    broadcaster.flush(&f, &esplora_url, &logger).await;
    Ok(())
}

/// Sync chain state on the active session node.
/// Lightweight async — delegates to EsploraSyncClient, which performs Esplora HTTP calls.
#[wasm_bindgen]
pub async fn sync_chain_on_session(fetcher: &JsFetcher) -> Result<(), JsValue> {
    let f = JsFetcherImpl::new(fetcher);

    let (tx_sync, cm, chain_mon) = SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        Ok::<_, JsValue>((
            session.node.tx_sync(),
            session.node.channel_manager_ref(),
            session.node.chain_monitor_ref(),
        ))
    })?;

    let confirmables: Vec<&dyn lightning::chain::Confirm> = vec![
        &*cm as &dyn lightning::chain::Confirm,
        &*chain_mon as &dyn lightning::chain::Confirm,
    ];
    tx_sync
        .sync(confirmables, &f)
        .await
        .map_err(|e| JsValue::from_str(&format!("Chain sync failed: {}", e)))?;

    Ok(())
}

/// Teardown the active session: disconnect peers, drop the node.
/// JS handles persistence separately via needs_persistence() + serialize_channel_manager().
#[wasm_bindgen]
pub fn teardown_node() -> Result<(), JsValue> {
    SESSION.with(|s| {
        let session = s
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("No active session to teardown"))?;
        session.node.disconnect_all();
        drop(session);
        Ok(())
    })
}

// ── New DO storage persistence exports ───────────────────────────────────────

/// Signal that monitors have been durably persisted to DO storage.
/// JS calls this after writing pendingPersists to ctx.storage + sync().
#[wasm_bindgen]
pub fn signal_monitors_persisted(completed_json: &str) -> Result<(), JsValue> {
    #[derive(serde::Deserialize)]
    struct CompletedPersist {
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "updateId")]
        update_id: u64,
    }

    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let completed: Vec<CompletedPersist> = serde_json::from_str(completed_json)
            .map_err(|e| JsValue::from_str(&format!("Deserialize failed: {}", e)))?;

        for c in completed {
            let id_bytes = hex::decode(&c.channel_id)
                .map_err(|e| JsValue::from_str(&format!("Hex decode failed: {}", e)))?;
            let channel_id = ChannelId::from_bytes(
                id_bytes
                    .try_into()
                    .map_err(|_| JsValue::from_str("Invalid channel_id length"))?,
            );
            session
                .chain_monitor
                .channel_monitor_updated(channel_id, c.update_id)
                .map_err(|e| {
                    JsValue::from_str(&format!("channel_monitor_updated failed: {:?}", e))
                })?;
        }

        Ok(())
    })
}

/// Check if ChannelManager needs persistence.
#[wasm_bindgen]
pub fn needs_persistence() -> Result<bool, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        Ok(session
            .node
            .channel_manager_ref()
            .get_and_clear_needs_persistence())
    })
}

/// Serialize the ChannelManager for DO storage persistence.
#[wasm_bindgen]
pub fn serialize_channel_manager() -> Result<Vec<u8>, JsValue> {
    use lightning::util::ser::Writeable;
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        let mut bytes = Vec::new();
        session
            .node
            .channel_manager_ref()
            .write(&mut bytes)
            .expect("CM serialization cannot fail");
        Ok(bytes)
    })
}

/// Prepare full ChannelMonitor re-persistence work for crash recovery.
///
/// Returns JSON array of `PendingPersistEntry` values. Each pending `updateId`
/// receives its own entry, even when multiple IDs map to the same full monitor
/// bytes, so JS can acknowledge every pending update after a single durable write.
#[wasm_bindgen]
pub fn prepare_pending_monitor_recovery() -> Result<String, JsValue> {
    use lightning::util::ser::Writeable;

    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let pending = session.chain_monitor.list_pending_monitor_updates();
        let mut entries = Vec::<node::PendingPersistEntry>::new();

        for (channel_id, update_ids) in pending {
            if update_ids.is_empty() {
                continue;
            }

            let key = session.persister.ensure_key_for_channel(channel_id);
            let monitor = session
                .chain_monitor
                .get_monitor(channel_id)
                .map_err(|_| JsValue::from_str("Missing monitor while preparing recovery"))?;
            let mut bytes = Vec::new();
            monitor
                .write(&mut bytes)
                .expect("monitor serialization cannot fail");
            let data = hex::encode(&bytes);

            for update_id in update_ids {
                entries.push(node::PendingPersistEntry {
                    key: key.clone(),
                    channel_id: hex::encode(channel_id.0),
                    update_id,
                    data: data.clone(),
                });
            }
        }

        serde_json::to_string(&entries)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// List pending monitor updates for crash recovery.
/// Returns JSON array of { channelId, key, updateIds }.
#[wasm_bindgen]
pub fn list_pending_monitor_updates() -> Result<String, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let pending = session.chain_monitor.list_pending_monitor_updates();
        let mut result = Vec::new();

        for (channel_id, update_ids) in pending {
            let key = session
                .persister
                .key_for_channel(&channel_id)
                .unwrap_or_default();
            result.push(serde_json::json!({
                "channelId": hex::encode(channel_id.0),
                "key": key,
                "updateIds": update_ids,
            }));
        }

        serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// Get node info on the active session (replaces get_info_from_prefetched).
#[wasm_bindgen]
pub fn get_info_on_session() -> Result<String, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        let info = session.node.get_info();
        serde_json::to_string(&info)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// Serialize sweepable outputs collected during the session for DO storage.
/// Returns empty vec if no sweepable outputs were collected.
#[wasm_bindgen]
pub fn serialize_sweepable_outputs() -> Result<Vec<u8>, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;
        if session.sweepable_outputs.is_empty() {
            return Ok(Vec::new());
        }
        serde_json::to_vec(&session.sweepable_outputs)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

/// Drain pending monitor writes from the persister (for use outside the pump loop,
/// e.g. after chain sync). Returns JSON: { persists: [...], deletes: [...] }.
#[wasm_bindgen]
pub fn take_pending_persists() -> Result<String, JsValue> {
    SESSION.with(|s| {
        let borrow = s.borrow();
        let session = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active session"))?;

        let entries: Vec<node::PendingPersistEntry> = session
            .persister
            .take_pending()
            .into_iter()
            .map(node::PendingPersistEntry::from)
            .collect();
        let deletes = session.persister.take_pending_deletes();

        let result = serde_json::json!({
            "persists": entries,
            "deletes": deletes,
        });

        serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialize failed: {}", e)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ldk_helpers::TEST_MNEMONIC;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_derive_node_id_deterministic() {
        let id1 = derive_node_id(TEST_MNEMONIC, "signet").unwrap();
        let id2 = derive_node_id(TEST_MNEMONIC, "signet").unwrap();
        assert_eq!(id1, id2, "same mnemonic + network should give same node_id");

        // Should be 66 hex chars (33 bytes compressed pubkey)
        assert_eq!(id1.len(), 66, "node_id should be 66 hex chars");
        // Should start with 02 or 03 (compressed pubkey prefix)
        assert!(
            id1.starts_with("02") || id1.starts_with("03"),
            "node_id should start with 02 or 03, got: {}",
            &id1[..2]
        );
    }

    #[wasm_bindgen_test]
    fn test_derive_node_id_different_networks_same_key() {
        let signet_id = derive_node_id(TEST_MNEMONIC, "signet").unwrap();
        let bitcoin_id = derive_node_id(TEST_MNEMONIC, "bitcoin").unwrap();
        assert_eq!(
            signet_id, bitcoin_id,
            "node_id is derived from seed, not network, so should be identical"
        );
    }

    #[wasm_bindgen_test]
    fn test_derive_node_id_invalid_network() {
        let result = derive_node_id(TEST_MNEMONIC, "foonet");
        assert!(result.is_err(), "invalid network should return Err");
    }

    #[wasm_bindgen_test]
    fn test_derive_node_id_invalid_mnemonic() {
        let result = derive_node_id("not a valid mnemonic", "signet");
        assert!(result.is_err(), "invalid mnemonic should return Err");
    }

    // ── parse_network tests ──────────────────────────────────────────────────

    #[wasm_bindgen_test]
    fn test_parse_network_all_variants() {
        assert_eq!(parse_network("bitcoin").unwrap(), Network::Bitcoin);
        assert_eq!(parse_network("mainnet").unwrap(), Network::Bitcoin);
        assert_eq!(parse_network("testnet").unwrap(), Network::Testnet);
        assert_eq!(parse_network("regtest").unwrap(), Network::Regtest);
        assert_eq!(parse_network("signet").unwrap(), Network::Signet);
    }

    #[wasm_bindgen_test]
    fn test_parse_network_invalid() {
        let result = parse_network("foonet");
        assert!(result.is_err());
        let err = result.unwrap_err().as_string().unwrap();
        assert!(
            err.contains("Unknown network"),
            "error should mention unknown network"
        );
    }

    #[wasm_bindgen_test]
    fn test_parse_network_case_sensitive() {
        // Network names are case-sensitive
        assert!(parse_network("Bitcoin").is_err());
        assert!(parse_network("SIGNET").is_err());
        assert!(parse_network("Mainnet").is_err());
    }

    // ── parse_pubkey tests ───────────────────────────────────────────────────

    #[wasm_bindgen_test]
    fn test_parse_pubkey_valid() {
        let hex = "02eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619";
        let pk = parse_pubkey(hex).unwrap();
        assert_eq!(pk.to_string(), hex);
    }

    #[wasm_bindgen_test]
    fn test_parse_pubkey_invalid_hex() {
        assert!(parse_pubkey("not-a-hex-string").is_err());
    }

    #[wasm_bindgen_test]
    fn test_parse_pubkey_wrong_length() {
        assert!(parse_pubkey("02eec7245d6b7d2ccb30").is_err());
    }

    #[wasm_bindgen_test]
    fn test_parse_pubkey_empty() {
        assert!(parse_pubkey("").is_err());
    }

    #[wasm_bindgen_test]
    fn test_parse_pubkey_invalid_prefix() {
        // Valid length but invalid prefix (05 instead of 02/03)
        let bad = "05eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619";
        assert!(parse_pubkey(bad).is_err());
    }

    // ── mnemonic_to_seed tests ───────────────────────────────────────────────

    #[wasm_bindgen_test]
    fn test_mnemonic_to_seed_valid() {
        let seed = mnemonic_to_seed(TEST_MNEMONIC).unwrap();
        assert_eq!(seed.len(), 32);
        // Same mnemonic should produce same seed
        let seed2 = mnemonic_to_seed(TEST_MNEMONIC).unwrap();
        assert_eq!(seed, seed2);
    }

    #[wasm_bindgen_test]
    fn test_mnemonic_to_seed_invalid_words() {
        let result =
            mnemonic_to_seed("foo bar baz qux quux corge grault garply waldo fred plugh xyzzy");
        assert!(result.is_err());
        let err = result.unwrap_err().as_string().unwrap();
        assert!(err.contains("Invalid mnemonic"));
    }

    #[wasm_bindgen_test]
    fn test_mnemonic_to_seed_wrong_word_count() {
        let result = mnemonic_to_seed("abandon abandon abandon");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_mnemonic_to_seed_different_mnemonics_different_seeds() {
        let seed1 = mnemonic_to_seed(TEST_MNEMONIC).unwrap();
        let other = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
        let seed2 = mnemonic_to_seed(other).unwrap();
        assert_ne!(
            seed1, seed2,
            "different mnemonics should produce different seeds"
        );
    }
}
