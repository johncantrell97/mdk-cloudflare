use bitcoin::block::Header;
use bitcoin::consensus::encode::{deserialize, Decodable};
use bitcoin::{BlockHash, MerkleBlock, Transaction, Txid};

use crate::io::Fetcher;

/// Decode a hex string into a consensus-decodable type.
fn decode_hex<T: Decodable>(hex: &str, label: &str) -> Result<T, String> {
    let bytes = hex::decode(hex.trim()).map_err(|e| format!("{} hex decode: {}", label, e))?;
    deserialize(&bytes).map_err(|e| format!("{} deserialize: {:?}", label, e))
}

#[derive(Debug)]
pub(crate) struct BlockStatus {
    pub in_best_chain: bool,
    pub height: Option<u32>,
}

#[derive(Debug)]
pub(crate) struct TxStatus {
    pub confirmed: bool,
    pub block_hash: Option<BlockHash>,
    pub block_height: Option<u32>,
}

#[derive(Debug)]
pub(crate) struct OutputStatus {
    pub txid: Option<Txid>,
    pub status: Option<TxStatus>,
}

pub(crate) struct EsploraClient {
    base_url: String,
}

impl EsploraClient {
    pub fn new(base_url: String) -> Self {
        Self { base_url }
    }

    pub async fn get_tip_hash(&self, fetcher: &impl Fetcher) -> Result<BlockHash, String> {
        let url = format!("{}/blocks/tip/hash", self.base_url);
        let text = fetcher
            .get_text(&url)
            .await
            .map_err(|e| format!("get_tip_hash failed: {}", e))?;
        text.trim()
            .parse::<BlockHash>()
            .map_err(|e| format!("get_tip_hash parse failed: {}", e))
    }

    pub async fn get_header_by_hash(
        &self,
        fetcher: &impl Fetcher,
        block_hash: &BlockHash,
    ) -> Result<Header, String> {
        let url = format!("{}/block/{}/header", self.base_url, block_hash);
        let text = fetcher
            .get_text(&url)
            .await
            .map_err(|e| format!("get_header_by_hash failed: {}", e))?;
        decode_hex(&text, "header")
    }

    pub async fn get_block_status(
        &self,
        fetcher: &impl Fetcher,
        block_hash: &BlockHash,
    ) -> Result<BlockStatus, String> {
        let url = format!("{}/block/{}/status", self.base_url, block_hash);
        let bytes = fetcher
            .get_json(&url)
            .await
            .map_err(|e| format!("get_block_status failed: {}", e))?;
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("get_block_status parse: {}", e))?;
        Ok(BlockStatus {
            in_best_chain: json
                .get("in_best_chain")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            height: json
                .get("height")
                .and_then(|v| v.as_u64())
                .map(|h| h as u32),
        })
    }

    pub async fn get_merkle_block(
        &self,
        fetcher: &impl Fetcher,
        txid: &Txid,
    ) -> Result<Option<MerkleBlock>, String> {
        let url = format!("{}/tx/{}/merkleblock-proof", self.base_url, txid);
        let val = fetcher.get_text(&url).await;
        match val {
            Ok(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                let mb: MerkleBlock = decode_hex(trimmed, "merkle_block")?;
                Ok(Some(mb))
            }
            // Esplora returns 404 for unconfirmed txs — treat fetch errors as "not found".
            Err(_) => Ok(None),
        }
    }

    pub async fn get_tx(
        &self,
        fetcher: &impl Fetcher,
        txid: &Txid,
    ) -> Result<Option<Transaction>, String> {
        let url = format!("{}/tx/{}/hex", self.base_url, txid);
        let val = fetcher.get_text(&url).await;
        match val {
            Ok(text) => {
                let tx: Transaction = decode_hex(&text, "tx")?;
                Ok(Some(tx))
            }
            // Esplora returns 404 for unknown txs — treat fetch errors as "not found".
            Err(_) => Ok(None),
        }
    }

    pub async fn get_output_status(
        &self,
        fetcher: &impl Fetcher,
        txid: &Txid,
        index: u64,
    ) -> Result<Option<OutputStatus>, String> {
        let url = format!("{}/tx/{}/outspend/{}", self.base_url, txid, index);
        let bytes = fetcher
            .get_json(&url)
            .await
            .map_err(|e| format!("get_output_status failed: {}", e))?;
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("get_output_status parse: {}", e))?;

        let spent = json.get("spent").and_then(|v| v.as_bool()).unwrap_or(false);
        if !spent {
            return Ok(None);
        }

        let spending_txid = json
            .get("txid")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Txid>().ok());

        let status = json.get("status").map(|status_val| {
            let confirmed = status_val
                .get("confirmed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let block_hash = status_val
                .get("block_hash")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<BlockHash>().ok());
            let block_height = status_val
                .get("block_height")
                .and_then(|v| v.as_u64())
                .map(|h| h as u32);
            TxStatus {
                confirmed,
                block_hash,
                block_height,
            }
        });

        Ok(Some(OutputStatus {
            txid: spending_txid,
            status,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_block_status(json_str: &str) -> BlockStatus {
        let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
        BlockStatus {
            in_best_chain: json
                .get("in_best_chain")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            height: json
                .get("height")
                .and_then(|v| v.as_u64())
                .map(|h| h as u32),
        }
    }

    fn parse_output_status(json_str: &str) -> Option<OutputStatus> {
        let json: serde_json::Value = serde_json::from_str(json_str).unwrap();

        let spent = json.get("spent").and_then(|v| v.as_bool()).unwrap_or(false);
        if !spent {
            return None;
        }

        let spending_txid = json
            .get("txid")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Txid>().ok());

        let status = json.get("status").map(|status_val| {
            let confirmed = status_val
                .get("confirmed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let block_hash = status_val
                .get("block_hash")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<BlockHash>().ok());
            let block_height = status_val
                .get("block_height")
                .and_then(|v| v.as_u64())
                .map(|h| h as u32);
            TxStatus {
                confirmed,
                block_hash,
                block_height,
            }
        });

        Some(OutputStatus {
            txid: spending_txid,
            status,
        })
    }

    #[test]
    fn block_status_parses_confirmed_block() {
        let bs = parse_block_status(r#"{"in_best_chain": true, "height": 800000}"#);
        assert!(bs.in_best_chain);
        assert_eq!(bs.height, Some(800000));
    }

    #[test]
    fn block_status_parses_orphaned_block() {
        let bs = parse_block_status(r#"{"in_best_chain": false}"#);
        assert!(!bs.in_best_chain);
        assert_eq!(bs.height, None);
    }

    #[test]
    fn output_status_parses_unspent() {
        let result = parse_output_status(r#"{"spent": false}"#);
        assert!(result.is_none());
    }

    #[test]
    fn output_status_parses_spent_confirmed() {
        let json_str = r#"{
            "spent": true,
            "txid": "0000000000000000000000000000000000000000000000000000000000000001",
            "status": {
                "confirmed": true,
                "block_hash": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
                "block_height": 700000
            }
        }"#;
        let result = parse_output_status(json_str).expect("should be Some");
        assert!(result.txid.is_some());
        let status = result.status.expect("should have status");
        assert!(status.confirmed);
        assert!(status.block_hash.is_some());
        assert_eq!(status.block_height, Some(700000));
    }
}
