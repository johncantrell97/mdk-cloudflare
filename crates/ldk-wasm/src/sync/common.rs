use bitcoin::block::Header;
use bitcoin::{BlockHash, OutPoint, Transaction, Txid};
use lightning::chain::channelmonitor::ANTI_REORG_DELAY;
use lightning::chain::{Confirm, WatchedOutput};

use std::collections::{HashMap, HashSet};
use std::ops::Deref;

pub(crate) struct SyncState {
    pub watched_transactions: HashSet<Txid>,
    pub watched_outputs: HashMap<OutPoint, WatchedOutput>,
    pub outputs_spends_pending_threshold_conf: Vec<(Txid, u32, OutPoint, WatchedOutput)>,
    pub last_sync_hash: Option<BlockHash>,
    pub pending_sync: bool,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            watched_transactions: HashSet::new(),
            watched_outputs: HashMap::new(),
            outputs_spends_pending_threshold_conf: Vec::new(),
            last_sync_hash: None,
            pending_sync: false,
        }
    }

    pub fn sync_unconfirmed_transactions<C: Deref>(
        &mut self,
        confirmables: &[C],
        unconfirmed_txs: Vec<Txid>,
    ) where
        C::Target: Confirm,
    {
        for txid in unconfirmed_txs {
            for c in confirmables {
                c.transaction_unconfirmed(&txid);
            }
            self.watched_transactions.insert(txid);
            self.outputs_spends_pending_threshold_conf.retain(
                |(conf_txid, _, prev_outpoint, output)| {
                    if txid == *conf_txid {
                        self.watched_outputs.insert(*prev_outpoint, output.clone());
                        false
                    } else {
                        true
                    }
                },
            )
        }
    }

    pub fn sync_confirmed_transactions<C: Deref>(
        &mut self,
        confirmables: &[C],
        confirmed_txs: Vec<ConfirmedTx>,
    ) where
        C::Target: Confirm,
    {
        for ctx in confirmed_txs {
            for c in confirmables {
                c.transactions_confirmed(
                    &ctx.block_header,
                    &[(ctx.pos, &ctx.tx)],
                    ctx.block_height,
                );
            }
            self.watched_transactions.remove(&ctx.txid);
            for input in &ctx.tx.input {
                if let Some(output) = self.watched_outputs.remove(&input.previous_output) {
                    let spent = (ctx.txid, ctx.block_height, input.previous_output, output);
                    self.outputs_spends_pending_threshold_conf.push(spent);
                }
            }
        }
    }

    pub fn prune_output_spends(&mut self, cur_height: u32) {
        self.outputs_spends_pending_threshold_conf
            .retain(|(_, conf_height, _, _)| cur_height < conf_height + ANTI_REORG_DELAY - 1);
    }
}

pub(crate) struct FilterQueue {
    pub transactions: HashSet<Txid>,
    pub outputs: HashMap<OutPoint, WatchedOutput>,
}

impl FilterQueue {
    pub fn new() -> Self {
        Self {
            transactions: HashSet::new(),
            outputs: HashMap::new(),
        }
    }

    pub fn process_queues(&mut self, sync_state: &mut SyncState) -> bool {
        let mut pending_registrations = false;
        if !self.transactions.is_empty() {
            pending_registrations = true;
            sync_state
                .watched_transactions
                .extend(self.transactions.drain());
        }
        if !self.outputs.is_empty() {
            pending_registrations = true;
            sync_state.watched_outputs.extend(self.outputs.drain());
        }
        pending_registrations
    }
}

#[derive(Debug)]
pub(crate) struct ConfirmedTx {
    pub tx: Transaction,
    pub txid: Txid,
    pub block_header: Header,
    pub block_height: u32,
    pub pos: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::hashes::Hash;

    fn dummy_txid(byte: u8) -> Txid {
        let mut bytes = [0u8; 32];
        bytes[0] = byte;
        Txid::from_byte_array(bytes)
    }

    fn dummy_outpoint(byte: u8) -> OutPoint {
        OutPoint {
            txid: dummy_txid(byte),
            vout: 0,
        }
    }

    #[test]
    fn filter_queue_drains_into_sync_state() {
        let mut queue = FilterQueue::new();
        let mut state = SyncState::new();

        let txid = dummy_txid(1);
        queue.transactions.insert(txid);

        let outpoint = dummy_outpoint(2);
        let wo = WatchedOutput {
            block_hash: None,
            outpoint: lightning::chain::transaction::OutPoint {
                txid: outpoint.txid,
                index: outpoint.vout as u16,
            },
            script_pubkey: bitcoin::ScriptBuf::new(),
        };
        queue.outputs.insert(outpoint, wo);

        let result = queue.process_queues(&mut state);
        assert!(result);
        assert!(state.watched_transactions.contains(&txid));
        assert!(state.watched_outputs.contains_key(&outpoint));
        assert!(queue.transactions.is_empty());
        assert!(queue.outputs.is_empty());
    }

    #[test]
    fn filter_queue_returns_false_when_empty() {
        let mut queue = FilterQueue::new();
        let mut state = SyncState::new();

        let result = queue.process_queues(&mut state);
        assert!(!result);
    }

    #[test]
    fn prune_output_spends_respects_anti_reorg_delay() {
        let mut state = SyncState::new();

        let txid = dummy_txid(1);
        let outpoint = dummy_outpoint(2);
        let wo = WatchedOutput {
            block_hash: None,
            outpoint: lightning::chain::transaction::OutPoint {
                txid: outpoint.txid,
                index: outpoint.vout as u16,
            },
            script_pubkey: bitcoin::ScriptBuf::new(),
        };

        let conf_height = 100u32;
        state
            .outputs_spends_pending_threshold_conf
            .push((txid, conf_height, outpoint, wo));

        // At height 100 + ANTI_REORG_DELAY - 2 → should still be retained
        state.prune_output_spends(conf_height + ANTI_REORG_DELAY - 2);
        assert_eq!(state.outputs_spends_pending_threshold_conf.len(), 1);

        // At height 100 + ANTI_REORG_DELAY - 1 → should be pruned
        state.prune_output_spends(conf_height + ANTI_REORG_DELAY - 1);
        assert!(state.outputs_spends_pending_threshold_conf.is_empty());
    }
}
