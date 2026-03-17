use std::cell::{Cell, RefCell};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use lightning::ln::peer_handler::SocketDescriptor;

/// A SocketDescriptor that buffers outbound data for async flushing.
///
/// Does NOT hold a JsSocket — the async pump loop owns the socket and
/// drains this descriptor's buffer. This keeps the descriptor lightweight
/// and avoids Send/Sync issues with JS objects.
#[derive(Clone, Debug)]
pub struct CfSocketDescriptor {
    id: u64,
    outbound_buffer: Rc<RefCell<Vec<u8>>>,
    disconnected: Rc<Cell<bool>>,
}

impl CfSocketDescriptor {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            outbound_buffer: Rc::new(RefCell::new(Vec::new())),
            disconnected: Rc::new(Cell::new(false)),
        }
    }

    /// Append data to the outbound buffer. Used to buffer initial handshake bytes.
    pub fn buffer_write(&self, data: &[u8]) {
        self.outbound_buffer.borrow_mut().extend_from_slice(data);
    }

    /// Take all buffered outbound data. Called by the pump loop to flush to the socket.
    pub fn take_buffered(&self) -> Vec<u8> {
        let mut buf = self.outbound_buffer.borrow_mut();
        std::mem::take(&mut *buf)
    }

    /// Check if disconnect was requested.
    pub fn is_disconnected(&self) -> bool {
        self.disconnected.get()
    }
}

impl SocketDescriptor for CfSocketDescriptor {
    fn send_data(&mut self, data: &[u8], _continue_read: bool) -> usize {
        if self.disconnected.get() {
            return 0;
        }
        self.outbound_buffer.borrow_mut().extend_from_slice(data);
        data.len()
    }

    fn disconnect_socket(&mut self) {
        self.disconnected.set(true);
    }
}

impl PartialEq for CfSocketDescriptor {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for CfSocketDescriptor {}

impl Hash for CfSocketDescriptor {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lightning::ln::peer_handler::SocketDescriptor;

    #[test]
    fn test_send_data_buffers() {
        let mut desc = CfSocketDescriptor::new(1);
        let n = desc.send_data(b"hello", true);
        assert_eq!(n, 5);
        assert_eq!(desc.take_buffered(), b"hello");
        // Buffer is drained after take
        assert!(desc.take_buffered().is_empty());
    }

    #[test]
    fn test_send_data_after_disconnect_returns_zero() {
        let mut desc = CfSocketDescriptor::new(1);
        desc.disconnect_socket();
        let n = desc.send_data(b"hello", true);
        assert_eq!(n, 0);
    }

    #[test]
    fn test_clone_shares_buffer() {
        let mut desc1 = CfSocketDescriptor::new(1);
        let desc2 = desc1.clone();
        desc1.send_data(b"data", true);
        // Clone shares the Rc, so both see the same buffer
        assert_eq!(desc2.take_buffered(), b"data");
    }

    #[test]
    fn test_equality_by_id() {
        let a = CfSocketDescriptor::new(42);
        let b = CfSocketDescriptor::new(42);
        let c = CfSocketDescriptor::new(99);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
