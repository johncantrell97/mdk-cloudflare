use std::cell::RefCell;

use lightning::events::{Event, EventsProvider, ReplayEvent};
use lightning::util::ser::Writeable;
use serde::Serialize;
use wasm_bindgen::JsValue;

use crate::types::ChannelManager;

/// A payment that was successfully claimed during this invocation.
#[derive(Debug, Serialize)]
pub struct ClaimedPayment {
    pub payment_hash: String,
    pub amount_msat: u64,
}

/// A payment that was successfully sent during this invocation.
#[derive(Debug, Serialize)]
pub struct SentPayment {
    pub payment_hash: String,
    pub preimage: String,
    pub amount_msat: Option<u64>,
    pub fee_paid_msat: Option<u64>,
}

/// Outcome of an outbound payment attempt.
#[derive(Debug)]
pub enum PaymentOutcome {
    Sent(SentPayment),
    Failed {
        payment_hash: String,
        reason: String,
    },
}

/// Channel balance summary.
#[derive(Debug, Serialize)]
pub struct ChannelInfo {
    pub channel_id: String,
    pub counterparty_node_id: String,
    pub channel_value_sats: u64,
    pub balance_msat: u64,
    pub inbound_capacity_msat: u64,
    pub outbound_capacity_msat: u64,
    pub is_usable: bool,
    pub is_channel_ready: bool,
}

/// Overall node info with balance summary.
#[derive(Debug, Serialize)]
pub struct NodeInfo {
    pub node_id: String,
    pub num_channels: usize,
    pub total_balance_msat: u64,
    pub total_inbound_capacity_msat: u64,
    pub channels: Vec<ChannelInfo>,
}

fn log(msg: &str) {
    js_sys::eval(&format!(
        "console.log({})",
        serde_json::to_string(msg).unwrap_or_default()
    ))
    .unwrap_or(JsValue::UNDEFINED);
}

/// Process all pending events from the ChannelManager.
///
/// Returns claimed inbound payments and outbound payment outcomes.
/// Spendable outputs are appended to `sweepable_outputs` as serialized bytes.
///
/// `lsp_pubkey` is used to validate `OpenChannelRequest` events: only channels
/// from the known LSP are accepted. Pass `None` to reject all inbound channel opens.
pub fn process_events(
    channel_manager: &ChannelManager,
    lsp_pubkey: Option<bitcoin::secp256k1::PublicKey>,
    sweepable_outputs: &mut Vec<Vec<u8>>,
) -> (Vec<ClaimedPayment>, Vec<PaymentOutcome>) {
    // EventHandler requires Fn (not FnMut), so we use RefCell for
    // interior mutability on our accumulator vectors.
    let claimed = RefCell::new(Vec::<ClaimedPayment>::new());
    let outcomes = RefCell::new(Vec::<PaymentOutcome>::new());
    let new_outputs = RefCell::new(Vec::<Vec<u8>>::new());

    channel_manager.process_pending_events(&|event: Event| -> Result<(), ReplayEvent> {
        match event {
            Event::PaymentClaimable {
                payment_hash,
                purpose,
                amount_msat,
                ..
            } => {
                log(&format!(
                    "[events] PaymentClaimable hash={} amount_msat={} purpose={:?}",
                    hex::encode(payment_hash.0),
                    amount_msat,
                    purpose
                ));
                if let Some(preimage) = purpose.preimage() {
                    channel_manager.claim_funds(preimage);
                    claimed.borrow_mut().push(ClaimedPayment {
                        payment_hash: hex::encode(payment_hash.0),
                        amount_msat,
                    });
                } else {
                    log(&format!(
                        "[events] PaymentClaimable has no preimage, skipping hash={}",
                        hex::encode(payment_hash.0)
                    ));
                }
            }
            Event::PaymentClaimed { .. } => {
                // Payment fully claimed — nothing to do beyond acknowledge.
            }
            Event::OpenChannelRequest {
                temporary_channel_id,
                counterparty_node_id,
                ..
            } => {
                if lsp_pubkey == Some(counterparty_node_id) {
                    log(&format!(
                        "[events] OpenChannelRequest from LSP {}",
                        counterparty_node_id
                    ));
                    // Accept inbound zero-conf channels from the LSP (JIT channel opens).
                    // Must use the 0conf variant so LDK marks the channel ready immediately
                    // without waiting for funding tx confirmation.
                    let _ = channel_manager.accept_inbound_channel_from_trusted_peer_0conf(
                        &temporary_channel_id,
                        &counterparty_node_id,
                        0,    // user_channel_id
                        None, // no config overrides
                    );
                } else {
                    log(&format!(
                        "[events] REJECTED OpenChannelRequest from non-LSP peer {}",
                        counterparty_node_id
                    ));
                }
            }
            Event::SpendableOutputs { outputs, .. } => {
                let mut out = new_outputs.borrow_mut();
                for output in outputs {
                    let mut bytes = Vec::new();
                    output
                        .write(&mut bytes)
                        .expect("in-memory serialization cannot fail");
                    out.push(bytes);
                }
            }

            // === Outbound payment events ===
            Event::PaymentSent {
                payment_hash,
                payment_preimage,
                amount_msat,
                fee_paid_msat,
                ..
            } => {
                log(&format!(
                    "[events] PaymentSent hash={} amount={:?} fee={:?}",
                    hex::encode(payment_hash.0),
                    amount_msat,
                    fee_paid_msat
                ));
                outcomes
                    .borrow_mut()
                    .push(PaymentOutcome::Sent(SentPayment {
                        payment_hash: hex::encode(payment_hash.0),
                        preimage: hex::encode(payment_preimage.0),
                        amount_msat,
                        fee_paid_msat,
                    }));
            }
            Event::PaymentFailed {
                payment_hash,
                reason,
                ..
            } => {
                let reason_str = format!("{:?}", reason);
                let hash_str = payment_hash
                    .map(|h| hex::encode(h.0))
                    .unwrap_or_else(|| "unknown".to_string());
                log(&format!(
                    "[events] PaymentFailed hash={} reason={}",
                    hash_str, reason_str
                ));
                outcomes.borrow_mut().push(PaymentOutcome::Failed {
                    payment_hash: hash_str,
                    reason: reason_str,
                });
            }
            Event::PaymentPathSuccessful { payment_hash, .. } => {
                log(&format!(
                    "[events] PaymentPathSuccessful hash={:?}",
                    payment_hash
                ));
            }
            Event::PaymentPathFailed {
                payment_hash,
                failure,
                short_channel_id,
                ..
            } => {
                log(&format!(
                    "[events] PaymentPathFailed hash={} scid={:?} failure={:?}",
                    hex::encode(payment_hash.0),
                    short_channel_id,
                    failure
                ));
            }

            // === Other events ===
            Event::ChannelReady { .. } => {}
            Event::ChannelClosed { reason, .. } => {
                log(&format!("[events] ChannelClosed reason={:?}", reason));
            }
            Event::HTLCIntercepted { .. } => {
                log("[events] HTLCIntercepted (unexpected)");
            }
            Event::HTLCHandlingFailed {
                prev_channel_id,
                failure_type,
                ..
            } => {
                log(&format!(
                    "[events] HTLCHandlingFailed prev_channel={} type={:?}",
                    hex::encode(prev_channel_id.0),
                    failure_type
                ));
            }
            other => {
                log(&format!(
                    "[events] Unhandled event: {:?}",
                    std::mem::discriminant(&other)
                ));
            }
        }
        Ok(())
    });

    sweepable_outputs.extend(new_outputs.into_inner());
    (claimed.into_inner(), outcomes.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ldk_helpers::{
        complete_handshake, test_channel_manager, test_channel_manager_from_seed, test_lsp_pubkey,
        test_peer_manager,
    };
    use bitcoin::Network;
    use lightning::sign::{NodeSigner, Recipient};
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_process_events_empty() {
        let (cm, _km) = test_channel_manager(Network::Signet);
        let mut sweepable = Vec::new();
        let (claimed, outcomes) = process_events(&cm, Some(test_lsp_pubkey()), &mut sweepable);
        assert!(
            claimed.is_empty(),
            "fresh node should have no claimed payments"
        );
        assert!(outcomes.is_empty(), "fresh node should have no outcomes");
        assert!(
            sweepable.is_empty(),
            "fresh node should have no sweepable outputs"
        );
    }

    #[wasm_bindgen_test]
    fn test_process_events_with_none_lsp() {
        let (cm, _km) = test_channel_manager(Network::Signet);
        let mut sweepable = Vec::new();
        let (claimed, outcomes) = process_events(&cm, None, &mut sweepable);
        assert!(
            claimed.is_empty(),
            "fresh node should have no claimed payments"
        );
        assert!(outcomes.is_empty(), "fresh node should have no outcomes");
    }

    #[wasm_bindgen_test]
    fn test_node_info_fresh_node() {
        let info = NodeInfo {
            node_id: "02deadbeef".to_string(),
            num_channels: 0,
            total_balance_msat: 0,
            total_inbound_capacity_msat: 0,
            channels: vec![],
        };
        assert_eq!(info.num_channels, 0);
        assert_eq!(info.total_balance_msat, 0);
        assert!(info.channels.is_empty());
    }

    /// Create two nodes with different seeds and complete the BOLT 8 handshake.
    /// Returns (cm_a, km_a, pm_a, cm_b, km_b, pm_b, desc_a, desc_b).
    fn two_connected_nodes() -> TwoNodeSetup {
        let seed_a = [1u8; 32];
        let seed_b = [2u8; 32];
        let (cm_a, km_a, chain_mon_a) = test_channel_manager_from_seed(seed_a, Network::Signet);
        let (cm_b, km_b, chain_mon_b) = test_channel_manager_from_seed(seed_b, Network::Signet);
        let pm_a = test_peer_manager(cm_a.clone(), km_a.clone(), chain_mon_a);
        let pm_b = test_peer_manager(cm_b.clone(), km_b.clone(), chain_mon_b);

        let pubkey_b = km_b.get_node_id(Recipient::Node).unwrap();
        let (desc_a, desc_b) = complete_handshake(&pm_a, &pm_b, pubkey_b);

        TwoNodeSetup {
            cm_a,
            km_a,
            pm_a,
            cm_b,
            km_b,
            pm_b,
            desc_a,
            desc_b,
        }
    }

    struct TwoNodeSetup {
        cm_a: std::sync::Arc<ChannelManager>,
        km_a: std::sync::Arc<lightning::sign::KeysManager>,
        pm_a: std::sync::Arc<crate::types::PeerManager>,
        cm_b: std::sync::Arc<ChannelManager>,
        km_b: std::sync::Arc<lightning::sign::KeysManager>,
        pm_b: std::sync::Arc<crate::types::PeerManager>,
        desc_a: crate::transport::CfSocketDescriptor,
        desc_b: crate::transport::CfSocketDescriptor,
    }

    #[wasm_bindgen_test]
    fn test_two_node_handshake() {
        let setup = two_connected_nodes();
        let pubkey_a = setup.km_a.get_node_id(Recipient::Node).unwrap();
        let pubkey_b = setup.km_b.get_node_id(Recipient::Node).unwrap();

        // Both sides should see each other as connected
        assert!(
            setup.pm_a.peer_by_node_id(&pubkey_b).is_some(),
            "Node A should see Node B as connected"
        );
        assert!(
            setup.pm_b.peer_by_node_id(&pubkey_a).is_some(),
            "Node B should see Node A as connected"
        );
    }

    #[wasm_bindgen_test]
    fn test_open_channel_request_accepted_from_lsp() {
        let setup = two_connected_nodes();
        let pubkey_a = setup.km_a.get_node_id(Recipient::Node).unwrap();
        let pubkey_b = setup.km_b.get_node_id(Recipient::Node).unwrap();

        // Node A opens a channel to Node B
        setup
            .cm_a
            .create_channel(pubkey_b, 100_000, 0, 0, None, None)
            .expect("create_channel should succeed");

        // Flush: A's PeerManager sends open_channel to B
        setup.pm_a.process_events();
        let msg_bytes = setup.desc_a.take_buffered();
        assert!(
            !msg_bytes.is_empty(),
            "open_channel message should be queued"
        );

        // Feed to B
        setup
            .pm_b
            .read_event(&mut setup.desc_b.clone(), &msg_bytes)
            .expect("B should process open_channel");
        setup.pm_b.process_events();

        // Node B processes events with Node A as the trusted LSP → should accept
        let mut sweepable = Vec::new();
        process_events(&setup.cm_b, Some(pubkey_a), &mut sweepable);

        // PeerManager must flush the accept_channel message to the descriptor
        setup.pm_b.process_events();
        let reply = setup.desc_b.take_buffered();
        assert!(!reply.is_empty(), "B should send accept_channel response");
    }

    #[wasm_bindgen_test]
    fn test_open_channel_request_rejected_from_non_lsp() {
        let setup = two_connected_nodes();
        let pubkey_b = setup.km_b.get_node_id(Recipient::Node).unwrap();

        // Node A opens a channel to Node B
        setup
            .cm_a
            .create_channel(pubkey_b, 100_000, 0, 0, None, None)
            .expect("create_channel should succeed");

        // Flush: A's PeerManager sends open_channel to B
        setup.pm_a.process_events();
        let msg_bytes = setup.desc_a.take_buffered();

        // Feed to B
        setup
            .pm_b
            .read_event(&mut setup.desc_b.clone(), &msg_bytes)
            .expect("B should process open_channel");
        setup.pm_b.process_events();

        // Node B processes events with a DIFFERENT pubkey as LSP → should reject
        let mut sweepable = Vec::new();
        process_events(&setup.cm_b, Some(test_lsp_pubkey()), &mut sweepable);

        // B should send an error/reject message (not accept_channel)
        // After rejection, the channel should not exist on B
        let channels = setup.cm_b.list_channels();
        assert!(
            channels.is_empty(),
            "rejected channel should not appear in channel list"
        );
    }

    #[wasm_bindgen_test]
    fn test_open_channel_request_rejected_when_no_lsp() {
        let setup = two_connected_nodes();
        let pubkey_b = setup.km_b.get_node_id(Recipient::Node).unwrap();

        // Node A opens a channel to Node B
        setup
            .cm_a
            .create_channel(pubkey_b, 100_000, 0, 0, None, None)
            .expect("create_channel should succeed");

        // Flush + feed to B
        setup.pm_a.process_events();
        let msg_bytes = setup.desc_a.take_buffered();
        setup
            .pm_b
            .read_event(&mut setup.desc_b.clone(), &msg_bytes)
            .expect("B should process open_channel");
        setup.pm_b.process_events();

        // Node B processes events with None LSP → should reject all opens
        let mut sweepable = Vec::new();
        process_events(&setup.cm_b, None, &mut sweepable);

        let channels = setup.cm_b.list_channels();
        assert!(
            channels.is_empty(),
            "channel should be rejected when no LSP is set"
        );
    }
}
