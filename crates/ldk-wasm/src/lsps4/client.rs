use core::cell::RefCell;

use bitcoin::secp256k1::PublicKey;
use lightning::ln::msgs;
use lightning::ln::peer_handler::CustomMessageHandler;
use lightning::ln::wire::{CustomMessageReader, Type};
use lightning::types::features::{InitFeatures, NodeFeatures};
use lightning::util::ser::{LengthLimitedRead, Writeable, Writer};

use crate::lsps4::msgs::{
    build_register_node_request, parse_register_node_response, Lsps4Registration, LSPS_MESSAGE_TYPE,
};

/// Wire message wrapper for LSPS0 custom messages.
#[derive(Debug)]
pub struct LspsMessage {
    pub payload: Vec<u8>,
}

impl Type for LspsMessage {
    fn type_id(&self) -> u16 {
        LSPS_MESSAGE_TYPE
    }
}

impl Writeable for LspsMessage {
    fn write<W: Writer>(&self, writer: &mut W) -> Result<(), lightning::io::Error> {
        writer.write_all(&self.payload)
    }
}

/// Handles LSPS4 custom messages on the peer connection.
///
/// This is plugged into LDK's PeerManager as the `CustomMessageHandler`. It:
/// 1. Queues outbound LSPS4 register_node requests (called from EphemeralNode)
/// 2. PeerManager picks them up via `get_and_clear_pending_msg()` and sends over the wire
/// 3. When the LSP responds, PeerManager delivers the message via `handle_custom_message()`
/// 4. The handler parses the response and stores it for `take_registration()` to retrieve
pub struct Lsps4MessageHandler {
    pending_outbound: RefCell<Vec<(PublicKey, LspsMessage)>>,
    pending_response: RefCell<Option<Result<Lsps4Registration, String>>>,
    request_counter: RefCell<u64>,
}

impl Lsps4MessageHandler {
    pub fn new() -> Self {
        Self {
            pending_outbound: RefCell::new(Vec::new()),
            pending_response: RefCell::new(None),
            request_counter: RefCell::new(0),
        }
    }

    /// Queue an LSPS4 register_node request to be sent to the given LSP.
    pub fn send_register_node(&self, lsp_pubkey: PublicKey) {
        let mut counter = self.request_counter.borrow_mut();
        *counter += 1;
        let request_id = format!("ldk-cf-{}", *counter);
        let payload = build_register_node_request(&request_id);
        self.pending_outbound
            .borrow_mut()
            .push((lsp_pubkey, LspsMessage { payload }));
    }

    /// Take the most recent registration response, if any.
    pub fn take_registration(&self) -> Option<Result<Lsps4Registration, String>> {
        self.pending_response.borrow_mut().take()
    }
}

impl CustomMessageReader for Lsps4MessageHandler {
    type CustomMessage = LspsMessage;

    fn read<R: LengthLimitedRead>(
        &self,
        message_type: u16,
        buffer: &mut R,
    ) -> Result<Option<LspsMessage>, msgs::DecodeError> {
        if message_type == LSPS_MESSAGE_TYPE {
            let remaining = buffer.remaining_bytes() as usize;
            let mut payload = vec![0u8; remaining];
            buffer
                .read_exact(&mut payload)
                .map_err(|_| msgs::DecodeError::Io(lightning::io::ErrorKind::Other))?;
            Ok(Some(LspsMessage { payload }))
        } else {
            Ok(None)
        }
    }
}

impl CustomMessageHandler for Lsps4MessageHandler {
    fn handle_custom_message(
        &self,
        msg: LspsMessage,
        _sender_node_id: PublicKey,
    ) -> Result<(), msgs::LightningError> {
        // Log raw LSPS4 response for debugging
        if let Ok(raw) = std::str::from_utf8(&msg.payload) {
            let _ = js_sys::eval(&format!(
                "console.log({})",
                serde_json::to_string(&format!("[lsps4] raw response: {}", raw))
                    .unwrap_or_default()
            ));
        }
        let result = parse_register_node_response(&msg.payload);
        if let Ok(ref reg) = result {
            let _ = js_sys::eval(&format!(
                "console.log({})",
                serde_json::to_string(&format!(
                    "[lsps4] parsed registration: scid={} cltv_delta={}",
                    reg.intercept_scid, reg.cltv_expiry_delta
                ))
                .unwrap_or_default()
            ));
        }
        *self.pending_response.borrow_mut() = Some(result);
        Ok(())
    }

    fn get_and_clear_pending_msg(&self) -> Vec<(PublicKey, Self::CustomMessage)> {
        std::mem::take(&mut *self.pending_outbound.borrow_mut())
    }

    fn provided_node_features(&self) -> NodeFeatures {
        NodeFeatures::empty()
    }

    fn provided_init_features(&self, _their_node_id: PublicKey) -> InitFeatures {
        InitFeatures::empty()
    }

    fn peer_disconnected(&self, _their_node_id: PublicKey) {}

    fn peer_connected(
        &self,
        _their_node_id: PublicKey,
        _msg: &msgs::Init,
        _inbound: bool,
    ) -> Result<(), ()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ldk_helpers::test_lsp_pubkey;
    use lightning::ln::peer_handler::CustomMessageHandler;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_send_register_node_queues_message() {
        let handler = Lsps4MessageHandler::new();
        handler.send_register_node(test_lsp_pubkey());

        let pending = handler.get_and_clear_pending_msg();
        assert_eq!(pending.len(), 1);

        let (pubkey, msg) = &pending[0];
        assert_eq!(*pubkey, test_lsp_pubkey());

        let payload_str = std::str::from_utf8(&msg.payload).unwrap();
        assert!(payload_str.contains("lsps4.register_node"));
    }

    #[wasm_bindgen_test]
    fn test_send_register_node_increments_request_id() {
        let handler = Lsps4MessageHandler::new();
        handler.send_register_node(test_lsp_pubkey());
        handler.send_register_node(test_lsp_pubkey());

        let pending = handler.get_and_clear_pending_msg();
        assert_eq!(pending.len(), 2);

        let payload1 = std::str::from_utf8(&pending[0].1.payload).unwrap();
        let payload2 = std::str::from_utf8(&pending[1].1.payload).unwrap();
        assert!(payload1.contains("ldk-cf-1"));
        assert!(payload2.contains("ldk-cf-2"));
    }

    #[wasm_bindgen_test]
    fn test_handle_valid_registration_response() {
        let handler = Lsps4MessageHandler::new();
        let response_json = r#"{"jsonrpc":"2.0","result":{"jit_channel_scid":"800x3x0","lsp_cltv_expiry_delta":80},"id":"ldk-cf-1"}"#;
        let msg = LspsMessage {
            payload: response_json.as_bytes().to_vec(),
        };

        handler
            .handle_custom_message(msg, test_lsp_pubkey())
            .unwrap();

        let reg = handler.take_registration();
        assert!(reg.is_some());
        let reg = reg.unwrap().unwrap();
        assert_eq!(reg.intercept_scid, (800u64 << 40) | (3u64 << 16));
        assert_eq!(reg.cltv_expiry_delta, 80);
    }

    #[wasm_bindgen_test]
    fn test_handle_error_response() {
        let handler = Lsps4MessageHandler::new();
        let response_json =
            r#"{"jsonrpc":"2.0","error":{"code":-1,"message":"rate limited"},"id":"ldk-cf-1"}"#;
        let msg = LspsMessage {
            payload: response_json.as_bytes().to_vec(),
        };

        handler
            .handle_custom_message(msg, test_lsp_pubkey())
            .unwrap();

        let reg = handler.take_registration();
        assert!(reg.is_some());
        assert!(reg.unwrap().is_err());
    }

    #[wasm_bindgen_test]
    fn test_take_registration_none_initially() {
        let handler = Lsps4MessageHandler::new();
        assert!(handler.take_registration().is_none());
    }

    #[wasm_bindgen_test]
    fn test_take_registration_clears_after_read() {
        let handler = Lsps4MessageHandler::new();
        let response_json = r#"{"jsonrpc":"2.0","result":{"jit_channel_scid":"800x3x0","lsp_cltv_expiry_delta":80},"id":"ldk-cf-1"}"#;
        let msg = LspsMessage {
            payload: response_json.as_bytes().to_vec(),
        };

        handler
            .handle_custom_message(msg, test_lsp_pubkey())
            .unwrap();

        // First take should return Some
        assert!(handler.take_registration().is_some());
        // Second take should return None (cleared)
        assert!(handler.take_registration().is_none());
    }
}
