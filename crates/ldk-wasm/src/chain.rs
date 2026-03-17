use std::cell::RefCell;
use std::collections::HashMap;

use bitcoin::Transaction;
use lightning::chain::chaininterface::{BroadcasterInterface, ConfirmationTarget, FeeEstimator};

use crate::io::Fetcher;

// Sound: WASM is single-threaded. Required because these are wrapped in Arc for LDK traits.
unsafe impl Send for EsploraFeeEstimator {}
unsafe impl Sync for EsploraFeeEstimator {}
unsafe impl Send for EsploraBroadcaster {}
unsafe impl Sync for EsploraBroadcaster {}

/// Fee estimator that fetches rates from Esplora and caches them per invocation.
pub struct EsploraFeeEstimator {
    cached_rates: RefCell<HashMap<ConfirmationTarget, u32>>,
}

impl EsploraFeeEstimator {
    pub fn new() -> Self {
        Self {
            cached_rates: RefCell::new(HashMap::new()),
        }
    }

    /// Fetch fee estimates from Esplora and populate cache.
    /// Call once at the start of each Worker invocation.
    pub async fn refresh(&self, fetcher: &impl Fetcher, esplora_url: &str) -> Result<(), String> {
        let url = format!("{}/fee-estimates", esplora_url);
        let result = fetcher
            .get_json(&url)
            .await
            .map_err(|e| format!("Fee estimate fetch failed: {}", e))?;
        self.populate_from_json(&result)
    }

    /// Populate fee cache from raw Esplora JSON bytes (no I/O).
    /// Used by the prefetch/sync restore path to avoid async.
    pub fn populate_from_json(&self, json_bytes: &[u8]) -> Result<(), String> {
        // Esplora returns { "1": 87.882, "2": 87.882, ... } (sat/vbyte by confirmation target)
        let rates: HashMap<String, f64> =
            serde_json::from_slice(json_bytes).map_err(|e| format!("Fee parse failed: {}", e))?;

        let mut cache = self.cached_rates.borrow_mut();

        // Convert sat/vbyte to sat/kw (1 vbyte = 4 weight units, 1000 weight units per kw)
        let sat_per_vbyte_to_sat_per_kw = |spv: f64| -> u32 {
            std::cmp::max((spv * 250.0) as u32, 253) // LDK minimum is 253
        };

        // Map Esplora confirmation targets to LDK targets
        let get_rate = |block_target: &str| -> u32 {
            rates
                .get(block_target)
                .map(|r| sat_per_vbyte_to_sat_per_kw(*r))
                .unwrap_or(253)
        };

        cache.insert(ConfirmationTarget::UrgentOnChainSweep, get_rate("1"));
        cache.insert(ConfirmationTarget::MaximumFeeEstimate, get_rate("1"));
        cache.insert(ConfirmationTarget::NonAnchorChannelFee, get_rate("3"));
        cache.insert(ConfirmationTarget::AnchorChannelFee, get_rate("6"));
        cache.insert(ConfirmationTarget::ChannelCloseMinimum, get_rate("12"));
        cache.insert(ConfirmationTarget::OutputSpendingFee, get_rate("12"));
        cache.insert(
            ConfirmationTarget::MinAllowedAnchorChannelRemoteFee,
            get_rate("25"),
        );
        cache.insert(
            ConfirmationTarget::MinAllowedNonAnchorChannelRemoteFee,
            get_rate("25"),
        );

        Ok(())
    }
}

impl FeeEstimator for EsploraFeeEstimator {
    fn get_est_sat_per_1000_weight(&self, confirmation_target: ConfirmationTarget) -> u32 {
        *self
            .cached_rates
            .borrow()
            .get(&confirmation_target)
            .unwrap_or(&253)
    }
}

/// Transaction broadcaster that POSTs raw transactions to Esplora.
pub struct EsploraBroadcaster {
    /// Transactions queued for broadcast. Flushed async after event processing.
    pending_txs: RefCell<Vec<Vec<u8>>>,
}

impl EsploraBroadcaster {
    pub fn new() -> Self {
        Self {
            pending_txs: RefCell::new(Vec::new()),
        }
    }

    /// Flush pending broadcasts to Esplora. Called from async context.
    /// Broadcast failures are logged but not fatal — rebroadcasting already-confirmed
    /// transactions is normal (esplora returns 400 for duplicates).
    pub async fn flush(
        &self,
        fetcher: &impl Fetcher,
        esplora_url: &str,
        logger: &crate::logger::JsLogger,
    ) {
        let txs: Vec<Vec<u8>> = self.pending_txs.borrow_mut().drain(..).collect();
        for tx_bytes in txs {
            let hex = hex::encode(&tx_bytes);
            let url = format!("{}/tx", esplora_url);
            match fetcher.post_bytes(&url, hex.as_bytes()).await {
                Ok(_) => {
                    crate::logger::log_info(
                        logger,
                        &format!("Broadcast tx ({} bytes) OK", tx_bytes.len()),
                    );
                }
                Err(e) => {
                    // Not fatal — likely a duplicate/already-confirmed tx
                    crate::logger::log_info(
                        logger,
                        &format!(
                            "Broadcast tx ({} bytes) failed (non-fatal): {}",
                            tx_bytes.len(),
                            e
                        ),
                    );
                }
            }
        }
    }
}

impl BroadcasterInterface for EsploraBroadcaster {
    fn broadcast_transactions(&self, txs: &[&Transaction]) {
        let mut pending = self.pending_txs.borrow_mut();
        for tx in txs {
            let mut bytes = Vec::new();
            bitcoin::consensus::encode::Encodable::consensus_encode(*tx, &mut bytes)
                .expect("tx encoding cannot fail");
            pending.push(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{MockFetcher, MockResponse};
    use lightning::chain::chaininterface::ConfirmationTarget;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    async fn test_refresh_parses_fee_estimates() {
        let fetcher = MockFetcher::new();
        fetcher.on_get_json(
            "/fee-estimates",
            MockResponse::OkText(r#"{"1": 10.0, "3": 5.0, "6": 3.0, "12": 2.0, "25": 1.0}"#.into()),
        );

        let estimator = EsploraFeeEstimator::new();
        estimator
            .refresh(&fetcher, "https://esplora.example.com")
            .await
            .unwrap();

        // 10 sat/vbyte * 250 = 2500 sat/kw
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(ConfirmationTarget::UrgentOnChainSweep),
            2500
        );
        // 5 sat/vbyte * 250 = 1250
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(ConfirmationTarget::NonAnchorChannelFee),
            1250
        );
        // 3 sat/vbyte * 250 = 750
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(ConfirmationTarget::AnchorChannelFee),
            750
        );
    }

    #[wasm_bindgen_test]
    fn test_default_fee_before_refresh() {
        let estimator = EsploraFeeEstimator::new();
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(ConfirmationTarget::UrgentOnChainSweep),
            253
        );
    }

    #[wasm_bindgen_test]
    async fn test_refresh_enforces_minimum_fee() {
        let fetcher = MockFetcher::new();
        fetcher.on_get_json(
            "/fee-estimates",
            MockResponse::OkText(r#"{"1": 0.5, "3": 0.5, "6": 0.5, "12": 0.5, "25": 0.5}"#.into()),
        );

        let estimator = EsploraFeeEstimator::new();
        estimator
            .refresh(&fetcher, "https://esplora.example.com")
            .await
            .unwrap();

        // 0.5 * 250 = 125, but minimum is 253
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(ConfirmationTarget::UrgentOnChainSweep),
            253
        );
        assert_eq!(
            estimator.get_est_sat_per_1000_weight(
                ConfirmationTarget::MinAllowedNonAnchorChannelRemoteFee
            ),
            253
        );
    }

    #[wasm_bindgen_test]
    async fn test_refresh_error_propagates() {
        let fetcher = MockFetcher::new();
        fetcher.on_get_json("/fee-estimates", MockResponse::Err("network error".into()));

        let estimator = EsploraFeeEstimator::new();
        let result = estimator
            .refresh(&fetcher, "https://esplora.example.com")
            .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("network error"));
    }

    #[wasm_bindgen_test]
    fn test_broadcast_buffers_transactions() {
        let broadcaster = EsploraBroadcaster::new();

        // Create a minimal transaction (coinbase-like)
        let tx = Transaction {
            version: bitcoin::transaction::Version(2),
            lock_time: bitcoin::locktime::absolute::LockTime::ZERO,
            input: vec![bitcoin::TxIn::default()],
            output: vec![bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(50_000),
                script_pubkey: bitcoin::ScriptBuf::new(),
            }],
        };

        broadcaster.broadcast_transactions(&[&tx]);
        assert!(!broadcaster.pending_txs.borrow().is_empty());
        assert_eq!(broadcaster.pending_txs.borrow().len(), 1);
    }

    #[wasm_bindgen_test]
    async fn test_flush_posts_to_esplora() {
        let broadcaster = EsploraBroadcaster::new();
        let logger = crate::logger::JsLogger::new(None);

        // Push raw bytes directly to pending_txs
        broadcaster.pending_txs.borrow_mut().push(vec![0xDE, 0xAD]);

        let fetcher = MockFetcher::new();
        fetcher.on_post_bytes("/tx", MockResponse::Ok(vec![]));

        broadcaster
            .flush(&fetcher, "https://esplora.example.com", &logger)
            .await;

        // Verify request was made
        let reqs = fetcher.requests_matching("/tx");
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method, "POST_BYTES");

        // Buffer should be drained
        assert!(broadcaster.pending_txs.borrow().is_empty());
    }

    #[wasm_bindgen_test]
    async fn test_flush_broadcast_error_is_non_fatal() {
        let broadcaster = EsploraBroadcaster::new();
        let logger = crate::logger::JsLogger::new(None);

        broadcaster.pending_txs.borrow_mut().push(vec![0x01, 0x02]);

        let fetcher = MockFetcher::new();
        fetcher.on_post_bytes("/tx", MockResponse::Err("400 bad request".into()));

        // Should not panic
        broadcaster
            .flush(&fetcher, "https://esplora.example.com", &logger)
            .await;

        // Buffer should still be drained (errors are non-fatal)
        assert!(broadcaster.pending_txs.borrow().is_empty());
    }
}
