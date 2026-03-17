use std::cell::RefCell;
use std::sync::Arc;

use bitcoin::secp256k1::PublicKey;
use bitcoin::Network;
use lightning::chain::BestBlock;
use lightning::ln::channelmanager::ChainParameters;
use lightning::ln::peer_handler::{
    IgnoringMessageHandler, MessageHandler, PeerManager as LdkPeerManager,
};
use lightning::onion_message::messenger::NullMessageRouter;
use lightning::routing::gossip::NetworkGraph;
use lightning::routing::scoring::{
    ProbabilisticScorer, ProbabilisticScoringDecayParameters, ProbabilisticScoringFeeParameters,
};
use lightning::sign::{KeysManager, NodeSigner, Recipient};

use crate::chain::{EsploraBroadcaster, EsploraFeeEstimator};
use crate::config::create_user_config;
use crate::logger::JsLogger;
use crate::lsps4::client::Lsps4MessageHandler;
use crate::persist::DoPersister;
use crate::transport::CfSocketDescriptor;
use crate::types::{ActiveRouter, ChainMonitor, ChannelManager, PeerManager};

/// Test mnemonic (BIP39 "abandon" x11 + "about").
pub const TEST_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// Build a fresh `ChannelManager` and its `KeysManager` for testing.
///
/// This mirrors `EphemeralNode::create_fresh_channel_manager` but does not
/// require a full node restore. Suitable for unit-testing invoice creation
/// and other ChannelManager-dependent logic.
pub fn test_channel_manager(network: Network) -> (Arc<ChannelManager>, Arc<KeysManager>) {
    let (cm, km, _chain_mon) = test_channel_manager_with_chain_monitor(network);
    (cm, km)
}

/// Build a fresh ChannelManager from the test mnemonic, also returning
/// the ChainMonitor (needed for PeerManager's send_only_message_handler).
pub fn test_channel_manager_with_chain_monitor(
    network: Network,
) -> (Arc<ChannelManager>, Arc<KeysManager>, Arc<ChainMonitor>) {
    let seed = crate::mnemonic_to_seed(TEST_MNEMONIC).unwrap();
    test_channel_manager_from_seed(seed, network)
}

/// Build a ChannelManager from a raw 32-byte seed. Used to create nodes with
/// different identities for two-node tests.
pub fn test_channel_manager_from_seed(
    seed: [u8; 32],
    network: Network,
) -> (Arc<ChannelManager>, Arc<KeysManager>, Arc<ChainMonitor>) {
    let logger = Arc::new(JsLogger::new(None));
    let fee_estimator = Arc::new(EsploraFeeEstimator::new());
    let broadcaster = Arc::new(EsploraBroadcaster::new());
    let keys_manager = Arc::new(KeysManager::new(&seed, 0, 0, false));

    let persister = Arc::new(DoPersister::new());

    let peer_storage_key = keys_manager.get_peer_storage_key();
    let chain_monitor: Arc<ChainMonitor> =
        Arc::new(lightning::chain::chainmonitor::ChainMonitor::new(
            None,
            broadcaster.clone(),
            logger.clone(),
            fee_estimator.clone(),
            persister,
            keys_manager.clone(),
            peer_storage_key,
        ));

    let network_graph = Arc::new(NetworkGraph::new(network, logger.clone()));
    let scorer = Arc::new(RefCell::new(ProbabilisticScorer::new(
        ProbabilisticScoringDecayParameters::default(),
        network_graph.clone(),
        logger.clone(),
    )));
    let router: Arc<ActiveRouter> = Arc::new(lightning::routing::router::DefaultRouter::new(
        network_graph,
        logger.clone(),
        keys_manager.clone(),
        scorer,
        ProbabilisticScoringFeeParameters::default(),
    ));

    let best_block = BestBlock::new(
        bitcoin::blockdata::constants::genesis_block(network)
            .header
            .block_hash(),
        0,
    );

    let cm = Arc::new(ChannelManager::new(
        fee_estimator,
        chain_monitor.clone(),
        broadcaster,
        router,
        Arc::new(NullMessageRouter {}),
        logger,
        keys_manager.clone(),
        keys_manager.clone(),
        keys_manager.clone(),
        create_user_config(),
        ChainParameters {
            network,
            best_block,
        },
        0,
    ));

    (cm, keys_manager, chain_monitor)
}

/// Build a PeerManager for testing from an existing ChannelManager + KeysManager + ChainMonitor.
pub fn test_peer_manager(
    cm: Arc<ChannelManager>,
    km: Arc<KeysManager>,
    chain_monitor: Arc<ChainMonitor>,
) -> Arc<PeerManager> {
    let logger = Arc::new(JsLogger::new(None));
    let lsps4_handler = Arc::new(Lsps4MessageHandler::new());
    // Derive ephemeral seed from the node's public key for uniqueness
    let node_id = km.get_node_id(Recipient::Node).unwrap();
    let mut ephemeral_seed = [0u8; 32];
    ephemeral_seed.copy_from_slice(&node_id.serialize()[1..33]);
    Arc::new(LdkPeerManager::new(
        MessageHandler {
            chan_handler: cm,
            route_handler: Arc::new(IgnoringMessageHandler {}),
            onion_message_handler: Arc::new(IgnoringMessageHandler {}),
            custom_message_handler: lsps4_handler,
            send_only_message_handler: chain_monitor,
        },
        0,
        &ephemeral_seed,
        logger,
        km,
    ))
}

/// Complete BOLT 8 noise handshake + Init exchange between two PeerManagers.
/// Returns the CfSocketDescriptors for continued message exchange.
pub fn complete_handshake(
    pm_a: &PeerManager,
    pm_b: &PeerManager,
    pubkey_b: PublicKey,
) -> (CfSocketDescriptor, CfSocketDescriptor) {
    let desc_a = CfSocketDescriptor::new(1);
    let desc_b = CfSocketDescriptor::new(2);

    // Act 1: A → B
    let act1 = pm_a
        .new_outbound_connection(pubkey_b, desc_a.clone(), None)
        .expect("outbound connection should succeed");
    pm_b.new_inbound_connection(desc_b.clone(), None)
        .expect("inbound connection should succeed");
    pm_b.read_event(&mut desc_b.clone(), &act1)
        .expect("Act 1 should be processed");
    pm_b.process_events();

    // Act 2: B → A
    let act2 = desc_b.take_buffered();
    pm_a.read_event(&mut desc_a.clone(), &act2)
        .expect("Act 2 should be processed");
    pm_a.process_events();

    // Act 3 + Init: A → B
    let act3_init = desc_a.take_buffered();
    pm_b.read_event(&mut desc_b.clone(), &act3_init)
        .expect("Act 3 + Init should be processed");
    pm_b.process_events();

    // Init response: B → A
    let init_b = desc_b.take_buffered();
    if !init_b.is_empty() {
        pm_a.read_event(&mut desc_a.clone(), &init_b)
            .expect("Init response should be processed");
        pm_a.process_events();
    }

    (desc_a, desc_b)
}

/// A fixed public key usable as test LSP pubkey.
pub fn test_lsp_pubkey() -> PublicKey {
    PublicKey::from_slice(
        &hex::decode("02eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619").unwrap(),
    )
    .unwrap()
}
