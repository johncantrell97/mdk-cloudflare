//! Concrete type aliases for all LDK generic parameters.
//!
//! LDK uses heavily parameterized generics. We resolve them once here
//! so the rest of the codebase uses readable type names.

use std::cell::RefCell;
use std::sync::Arc;

use lightning::chain::chainmonitor::ChainMonitor as LdkChainMonitor;
use lightning::chain::Filter;
use lightning::ln::channelmanager::ChannelManager as LdkChannelManager;
use lightning::ln::peer_handler::{IgnoringMessageHandler, PeerManager as LdkPeerManager};
use lightning::onion_message::messenger::NullMessageRouter;
use lightning::routing::gossip::NetworkGraph;
use lightning::routing::router::DefaultRouter;
use lightning::routing::scoring::{ProbabilisticScorer, ProbabilisticScoringFeeParameters};
use lightning::sign::{InMemorySigner, KeysManager};

use crate::chain::{EsploraBroadcaster, EsploraFeeEstimator};
use crate::logger::JsLogger;
use crate::lsps4::client::Lsps4MessageHandler;
use crate::persist::DoPersister;
use crate::transport::CfSocketDescriptor;

/// The Lightning Network graph — channel/node topology for routing.
pub type Graph = NetworkGraph<Arc<JsLogger>>;

/// Probabilistic scorer — estimates channel liquidity for route selection.
pub type Scorer = ProbabilisticScorer<Arc<Graph>, Arc<JsLogger>>;

/// The router used for outbound payments.
///
/// Uses LDK's DefaultRouter with a NetworkGraph and ProbabilisticScorer.
/// For receive-only paths, the graph is empty (zero overhead — the router
/// is never called unless send_payment() is invoked).
pub type ActiveRouter = DefaultRouter<
    Arc<Graph>,
    Arc<JsLogger>,
    Arc<KeysManager>,                  // EntropySource
    Arc<RefCell<Scorer>>,              // LockableScore wrapper
    ProbabilisticScoringFeeParameters, // ScoreParams
    Scorer,                            // ScoreLookUp
>;

/// The chain monitor watches channels and persists their state.
pub type ChainMonitor = LdkChainMonitor<
    InMemorySigner,
    Arc<dyn Filter + Send + Sync>,
    Arc<EsploraBroadcaster>,
    Arc<EsploraFeeEstimator>,
    Arc<JsLogger>,
    Arc<DoPersister>,
    Arc<KeysManager>,
>;

/// The channel manager handles all channel logic.
pub type ChannelManager = LdkChannelManager<
    Arc<ChainMonitor>,
    Arc<EsploraBroadcaster>,
    Arc<KeysManager>,
    Arc<KeysManager>,
    Arc<KeysManager>,
    Arc<EsploraFeeEstimator>,
    Arc<ActiveRouter>,
    Arc<NullMessageRouter>,
    Arc<JsLogger>,
>;

/// The peer manager handles BOLT 8 encrypted connections.
pub type PeerManager = LdkPeerManager<
    CfSocketDescriptor,
    Arc<ChannelManager>,         // ChannelMessageHandler
    Arc<IgnoringMessageHandler>, // RoutingMessageHandler
    Arc<IgnoringMessageHandler>, // OnionMessageHandler
    Arc<JsLogger>,
    Arc<Lsps4MessageHandler>, // CustomMessageHandler
    Arc<KeysManager>,         // NodeSigner
    Arc<ChainMonitor>,        // SendOnlyMessageHandler (enables PeerStorage)
>;
