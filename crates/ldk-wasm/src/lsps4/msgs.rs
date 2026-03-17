//! LSPS4 protocol message types.
//!
//! LSPS4 is MDK's custom protocol for JIT channels with offline nodes.
//! The client sends `lsps4.register_node` to get a persistent intercept SCID,
//! which is used as a route hint in invoices. When a payment arrives, the LSP
//! stores the HTLC and sends a webhook.
//!
//! Wire format: JSON-RPC payloads sent as LSPS0 custom messages (type 37913).

use serde::{Deserialize, Serialize};

pub const LSPS_MESSAGE_TYPE: u16 = 37913;
pub const LSPS4_REGISTER_NODE_METHOD: &str = "lsps4.register_node";

/// JSON-RPC request envelope
#[derive(Serialize, Debug)]
pub struct JsonRpcRequest<P: Serialize> {
    pub jsonrpc: &'static str,
    pub method: &'static str,
    pub params: P,
    pub id: String,
}

/// JSON-RPC response envelope
#[derive(Deserialize, Debug)]
pub struct JsonRpcResponse<R> {
    pub jsonrpc: String,
    pub result: Option<R>,
    pub error: Option<JsonRpcError>,
    pub id: String,
}

#[derive(Deserialize, Debug)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

/// Empty params for register_node request
#[derive(Serialize, Debug)]
pub struct RegisterNodeParams {}

/// Response from register_node
#[derive(Deserialize, Debug, Clone)]
pub struct RegisterNodeResponse {
    pub jit_channel_scid: String,
    pub lsp_cltv_expiry_delta: u32,
}

/// Parsed and validated registration result
#[derive(Debug, Clone)]
pub struct Lsps4Registration {
    pub intercept_scid: u64,
    pub cltv_expiry_delta: u32,
}

impl Lsps4Registration {
    /// Parse the SCID string "BBBxTTTx000" into a u64.
    pub fn from_response(resp: RegisterNodeResponse) -> Result<Self, String> {
        let scid = parse_scid(&resp.jit_channel_scid)?;
        Ok(Self {
            intercept_scid: scid,
            cltv_expiry_delta: resp.lsp_cltv_expiry_delta,
        })
    }
}

/// Parse "BBBxTTTxOOO" SCID format to u64.
/// Format: block_height (3 bytes) << 40 | tx_index (3 bytes) << 16 | output_index (2 bytes)
pub fn parse_scid(s: &str) -> Result<u64, String> {
    let parts: Vec<&str> = s.split('x').collect();
    if parts.len() != 3 {
        return Err(format!("Invalid SCID format: {}", s));
    }
    let block: u64 = parts[0]
        .parse()
        .map_err(|_| format!("Bad block in SCID: {}", s))?;
    let tx: u64 = parts[1]
        .parse()
        .map_err(|_| format!("Bad tx in SCID: {}", s))?;
    let out: u64 = parts[2]
        .parse()
        .map_err(|_| format!("Bad output in SCID: {}", s))?;

    if block >= (1 << 24) || tx >= (1 << 24) || out >= (1 << 16) {
        return Err(format!("SCID field out of range: {}", s));
    }

    Ok((block << 40) | (tx << 16) | out)
}

/// Build the register_node JSON-RPC request payload.
pub fn build_register_node_request(request_id: &str) -> Vec<u8> {
    let req = JsonRpcRequest {
        jsonrpc: "2.0",
        method: LSPS4_REGISTER_NODE_METHOD,
        params: RegisterNodeParams {},
        id: request_id.to_string(),
    };
    serde_json::to_vec(&req).expect("serialization cannot fail")
}

/// Parse a register_node JSON-RPC response.
pub fn parse_register_node_response(data: &[u8]) -> Result<Lsps4Registration, String> {
    let resp: JsonRpcResponse<RegisterNodeResponse> =
        serde_json::from_slice(data).map_err(|e| format!("LSPS4 response parse failed: {}", e))?;

    if let Some(err) = resp.error {
        return Err(format!("LSPS4 error {}: {}", err.code, err.message));
    }

    let result = resp.result.ok_or("LSPS4 response missing result")?;
    Lsps4Registration::from_response(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_scid() {
        let scid = parse_scid("100x50x0").unwrap();
        assert_eq!(scid, (100u64 << 40) | (50u64 << 16));
    }

    #[test]
    fn test_parse_scid_invalid() {
        assert!(parse_scid("invalid").is_err());
        assert!(parse_scid("1x2").is_err());
    }

    #[test]
    fn test_build_and_parse_roundtrip() {
        let req = build_register_node_request("test-1");
        let parsed: serde_json::Value = serde_json::from_slice(&req).unwrap();
        assert_eq!(parsed["method"], "lsps4.register_node");
        assert_eq!(parsed["id"], "test-1");
    }

    #[test]
    fn test_parse_response() {
        let json = r#"{"jsonrpc":"2.0","result":{"jit_channel_scid":"800x3x0","lsp_cltv_expiry_delta":144},"id":"1"}"#;
        let reg = parse_register_node_response(json.as_bytes()).unwrap();
        assert_eq!(reg.cltv_expiry_delta, 144);
        assert_eq!(reg.intercept_scid, (800u64 << 40) | (3u64 << 16));
    }

    #[test]
    fn test_parse_response_error() {
        let json =
            r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"invalid params"},"id":"1"}"#;
        let result = parse_register_node_response(json.as_bytes());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("-32600"), "error should contain code");
        assert!(
            err.contains("invalid params"),
            "error should contain message"
        );
    }

    #[test]
    fn test_parse_response_missing_result() {
        let json = r#"{"jsonrpc":"2.0","id":"1"}"#;
        let result = parse_register_node_response(json.as_bytes());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing result"));
    }

    #[test]
    fn test_parse_response_malformed_json() {
        let result = parse_register_node_response(b"not json");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_scid_with_output_index() {
        let scid = parse_scid("1x2x3").unwrap();
        assert_eq!(scid, (1u64 << 40) | (2u64 << 16) | 3);
    }
}
