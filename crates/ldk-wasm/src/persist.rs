use std::cell::RefCell;
use std::collections::HashMap;

use lightning::chain::chainmonitor::Persist;
use lightning::chain::channelmonitor::{ChannelMonitor, ChannelMonitorUpdate};
use lightning::chain::ChannelMonitorUpdateStatus;
use lightning::ln::types::ChannelId;
use lightning::sign::ecdsa::EcdsaChannelSigner;
use lightning::util::persist::MonitorName;
use lightning::util::ser::Writeable;

// Sound: WASM is single-threaded. Required because DoPersister is wrapped in Arc for LDK traits.
unsafe impl Send for DoPersister {}
unsafe impl Sync for DoPersister {}

/// A pending monitor write to be flushed to DO storage by JavaScript.
pub struct PendingMonitorPersist {
    pub channel_id: ChannelId,
    pub update_id: u64,
    /// DO storage key, e.g. "monitors/{monitor_name}"
    pub key: String,
    /// Full serialized ChannelMonitor bytes
    pub data: Vec<u8>,
}

/// Persister that buffers ChannelMonitor writes in memory and returns `InProgress`.
///
/// JavaScript drains pending writes via `take_pending()`, writes them to
/// DO `ctx.storage`, calls `storage.sync()` for durability, then signals
/// completion back to WASM via `ChainMonitor::channel_monitor_updated()`.
///
/// This persister has NO external dependencies — no HTTP client, no encryption,
/// no protobuf. It is a pure in-memory buffer.
pub struct DoPersister {
    pending: RefCell<Vec<PendingMonitorPersist>>,
    pending_deletes: RefCell<Vec<String>>,
    /// Maps ChannelId -> DO storage key ("monitors/{monitor_name}").
    /// Survives take_pending() drains so crash recovery can resolve keys.
    channel_key_map: RefCell<HashMap<ChannelId, String>>,
    /// Maps MonitorName -> DO storage key so archive callbacks can resolve
    /// whichever key format was used when the monitor was last persisted.
    monitor_name_map: RefCell<HashMap<String, String>>,
}

impl DoPersister {
    pub fn new() -> Self {
        Self {
            pending: RefCell::new(Vec::new()),
            pending_deletes: RefCell::new(Vec::new()),
            channel_key_map: RefCell::new(HashMap::new()),
            monitor_name_map: RefCell::new(HashMap::new()),
        }
    }

    /// Drain all pending monitor writes. Called by JS pump loop.
    /// The `channel_key_map` is NOT cleared — it survives for crash recovery.
    pub fn take_pending(&self) -> Vec<PendingMonitorPersist> {
        std::mem::take(&mut *self.pending.borrow_mut())
    }

    /// Drain all pending key deletions. Called by JS pump loop.
    pub fn take_pending_deletes(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending_deletes.borrow_mut())
    }

    /// Look up the DO storage key for a channel. Used for crash recovery
    /// to map `list_pending_monitor_updates()` ChannelIds to DO storage keys.
    pub fn key_for_channel(&self, channel_id: &ChannelId) -> Option<String> {
        self.channel_key_map.borrow().get(channel_id).cloned()
    }

    /// Pre-populate the channel_key_map from monitors loaded at startup.
    /// Called during node restore so crash recovery can resolve keys.
    pub fn register_channel_key(&self, channel_id: ChannelId, key: String) {
        self.channel_key_map.borrow_mut().insert(channel_id, key);
    }

    /// Associate a monitor name with its persisted storage key.
    pub fn register_monitor_name_key(&self, monitor_name: &MonitorName, key: String) {
        self.monitor_name_map
            .borrow_mut()
            .insert(monitor_name.to_string(), key);
    }

    /// Resolve the storage key for a channel, creating a deterministic fallback
    /// for channels that have not yet been durably persisted.
    pub fn ensure_key_for_channel(&self, channel_id: ChannelId) -> String {
        if let Some(key) = self.channel_key_map.borrow().get(&channel_id).cloned() {
            return key;
        }

        let key = channel_storage_key(&channel_id);
        self.channel_key_map
            .borrow_mut()
            .insert(channel_id, key.clone());
        key
    }

    /// Check if there are pending writes or deletes.
    pub fn has_pending(&self) -> bool {
        !self.pending.borrow().is_empty() || !self.pending_deletes.borrow().is_empty()
    }
}

fn monitor_key(name: &MonitorName) -> String {
    format!("monitors/{}", name)
}

fn channel_storage_key(channel_id: &ChannelId) -> String {
    format!("monitors/{}", hex::encode(channel_id.0))
}

impl<ChannelSigner: EcdsaChannelSigner> Persist<ChannelSigner> for DoPersister {
    fn persist_new_channel(
        &self,
        monitor_name: MonitorName,
        monitor: &ChannelMonitor<ChannelSigner>,
    ) -> ChannelMonitorUpdateStatus {
        let channel_id = monitor.channel_id();
        let key = self.ensure_key_for_channel(channel_id);
        let mut bytes = Vec::new();
        monitor
            .write(&mut bytes)
            .expect("serialization cannot fail");
        self.channel_key_map
            .borrow_mut()
            .insert(channel_id, key.clone());
        self.register_monitor_name_key(&monitor_name, key.clone());
        self.pending.borrow_mut().push(PendingMonitorPersist {
            channel_id,
            update_id: monitor.get_latest_update_id(),
            key,
            data: bytes,
        });
        ChannelMonitorUpdateStatus::InProgress
    }

    fn update_persisted_channel(
        &self,
        monitor_name: MonitorName,
        _update: Option<&ChannelMonitorUpdate>,
        monitor: &ChannelMonitor<ChannelSigner>,
    ) -> ChannelMonitorUpdateStatus {
        self.persist_new_channel(monitor_name, monitor)
    }

    fn archive_persisted_channel(&self, monitor_name: MonitorName) {
        let key = self
            .monitor_name_map
            .borrow_mut()
            .remove(&monitor_name.to_string())
            .unwrap_or_else(|| monitor_key(&monitor_name));
        self.pending_deletes.borrow_mut().push(key.clone());
        // Remove from channel_key_map by finding the ChannelId for this key
        let mut map = self.channel_key_map.borrow_mut();
        if let Some(channel_id) = map.iter().find(|(_, v)| *v == &key).map(|(k, _)| *k) {
            map.remove(&channel_id);
        }
    }

    fn get_and_clear_completed_updates(&self) -> Vec<(ChannelId, u64)> {
        // Completion is signaled via chain_monitor.channel_monitor_updated(),
        // not through this polling method.
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_persister_has_no_pending() {
        let p = DoPersister::new();
        assert!(!p.has_pending());
        assert!(p.take_pending().is_empty());
        assert!(p.take_pending_deletes().is_empty());
    }

    #[test]
    fn completed_updates_always_empty() {
        let p = DoPersister::new();
        use lightning::sign::InMemorySigner;
        let completed =
            <DoPersister as Persist<InMemorySigner>>::get_and_clear_completed_updates(&p);
        assert!(completed.is_empty());
    }

    #[test]
    fn register_and_lookup_channel_key() {
        let p = DoPersister::new();
        let channel_id = ChannelId::from_bytes([7u8; 32]);
        p.register_channel_key(channel_id, "monitors/test_mon".into());
        assert_eq!(
            p.key_for_channel(&channel_id),
            Some("monitors/test_mon".into())
        );

        let unknown = ChannelId::from_bytes([8u8; 32]);
        assert_eq!(p.key_for_channel(&unknown), None);
    }

    #[test]
    fn take_pending_drains_but_keeps_key_map() {
        let p = DoPersister::new();
        let channel_id = ChannelId::from_bytes([1u8; 32]);
        p.register_channel_key(channel_id, "monitors/mon_a".into());
        p.pending.borrow_mut().push(PendingMonitorPersist {
            channel_id,
            update_id: 1,
            key: "monitors/mon_a".into(),
            data: vec![1, 2, 3],
        });

        assert!(p.has_pending());
        let writes = p.take_pending();
        assert_eq!(writes.len(), 1);
        assert!(!p.has_pending()); // pending drained

        // But key map survives
        assert_eq!(
            p.key_for_channel(&channel_id),
            Some("monitors/mon_a".into())
        );
    }

    #[test]
    fn ensure_key_for_channel_is_deterministic() {
        let p = DoPersister::new();
        let channel_id = ChannelId::from_bytes([0xAB; 32]);

        let key = p.ensure_key_for_channel(channel_id);
        assert_eq!(key, format!("monitors/{}", "ab".repeat(32)));
        assert_eq!(p.key_for_channel(&channel_id), Some(key));
    }
}
