// WASM RefCell borrow discipline:
// NEVER hold a borrow() or borrow_mut() across an .await point.
// Single-threaded WASM uses RefCell instead of Mutex — but RefCell panics
// on overlapping borrows, and an .await can resume with a borrow still held.
// Always snapshot data into local variables, drop the borrow, then await.

use crate::io::Fetcher;
use crate::sync::client::EsploraClient;
use crate::sync::common::{ConfirmedTx, FilterQueue, SyncState};
use crate::sync::error::{InternalError, TxSyncError};

use lightning::chain::WatchedOutput;
use lightning::chain::{Confirm, Filter};
use lightning::util::logger::Logger;
use lightning::{log_debug, log_error, log_trace};

use bitcoin::{BlockHash, Script, Txid};

use core::ops::Deref;
use std::cell::RefCell;
use std::collections::HashSet;

// Sound: WASM is single-threaded. Required because EsploraSyncClient is wrapped in Arc
// for the Filter trait bound on ChainMonitor. Same pattern as chain.rs.
unsafe impl<L: Deref> Send for EsploraSyncClient<L> where L::Target: Logger {}
unsafe impl<L: Deref> Sync for EsploraSyncClient<L> where L::Target: Logger {}

pub struct EsploraSyncClient<L: Deref>
where
    L::Target: Logger,
{
    sync_state: RefCell<SyncState>,
    queue: RefCell<FilterQueue>,
    client: EsploraClient,
    logger: L,
}

impl<L: Deref> EsploraSyncClient<L>
where
    L::Target: Logger,
{
    pub fn new(server_url: String, logger: L) -> Self {
        let client = EsploraClient::new(server_url);
        Self {
            sync_state: RefCell::new(SyncState::new()),
            queue: RefCell::new(FilterQueue::new()),
            client,
            logger,
        }
    }

    pub async fn sync<C: Deref>(
        &self,
        confirmables: Vec<C>,
        fetcher: &impl Fetcher,
    ) -> Result<(), TxSyncError>
    where
        C::Target: Confirm,
    {
        log_trace!(self.logger, "Starting transaction sync.");

        let mut num_confirmed = 0u32;
        let mut num_unconfirmed = 0u32;

        let mut tip_hash = self.client.get_tip_hash(fetcher).await?;

        // Guard against infinite restarts in rapidly-reorganizing chains.
        // Cloudflare Workers have a 30s wall-clock limit; cap retries to stay within budget.
        const MAX_SYNC_ITERATIONS: u32 = 10;
        let mut iterations = 0u32;

        loop {
            iterations += 1;
            if iterations > MAX_SYNC_ITERATIONS {
                log_error!(
                    self.logger,
                    "Transaction sync exceeded {} iterations, aborting.",
                    MAX_SYNC_ITERATIONS
                );
                self.sync_state.borrow_mut().pending_sync = true;
                return Err(TxSyncError::Failed);
            }

            let pending_registrations = {
                let mut queue = self.queue.borrow_mut();
                let mut state = self.sync_state.borrow_mut();
                queue.process_queues(&mut state)
            };
            let tip_is_new = Some(tip_hash) != self.sync_state.borrow().last_sync_hash;

            if !self.sync_state.borrow().pending_sync && !pending_registrations && !tip_is_new {
                break;
            } else {
                if tip_is_new {
                    // Check for unconfirmed transactions (reorg detection).
                    match self
                        .get_unconfirmed_transactions(&confirmables, fetcher)
                        .await
                    {
                        Ok(unconfirmed_txs) => match self.client.get_tip_hash(fetcher).await {
                            Ok(check_tip_hash) => {
                                if check_tip_hash != tip_hash {
                                    tip_hash = check_tip_hash;
                                    log_debug!(self.logger, "Encountered inconsistency during transaction sync, restarting.");
                                    self.sync_state.borrow_mut().pending_sync = true;
                                    continue;
                                }
                                num_unconfirmed += unconfirmed_txs.len() as u32;
                                self.sync_state
                                    .borrow_mut()
                                    .sync_unconfirmed_transactions(&confirmables, unconfirmed_txs);
                            }
                            Err(err) => {
                                log_error!(self.logger,
                                        "Failed during transaction sync, aborting. Synced so far: {} confirmed, {} unconfirmed.",
                                        num_confirmed, num_unconfirmed
                                    );
                                self.sync_state.borrow_mut().pending_sync = true;
                                return Err(TxSyncError::from(err));
                            }
                        },
                        Err(err) => {
                            log_error!(self.logger,
                                "Failed during transaction sync, aborting. Synced so far: {} confirmed, {} unconfirmed.",
                                num_confirmed, num_unconfirmed
                            );
                            self.sync_state.borrow_mut().pending_sync = true;
                            return Err(TxSyncError::from(err));
                        }
                    }

                    match self
                        .sync_best_block_updated(&confirmables, &tip_hash, fetcher)
                        .await
                    {
                        Ok(()) => {}
                        Err(InternalError::Inconsistency) => {
                            log_debug!(
                                self.logger,
                                "Encountered inconsistency during transaction sync, restarting."
                            );
                            self.sync_state.borrow_mut().pending_sync = true;
                            continue;
                        }
                        Err(err) => {
                            log_error!(self.logger,
                                "Failed during transaction sync, aborting. Synced so far: {} confirmed, {} unconfirmed.",
                                num_confirmed, num_unconfirmed
                            );
                            self.sync_state.borrow_mut().pending_sync = true;
                            return Err(TxSyncError::from(err));
                        }
                    }
                }

                match self.get_confirmed_transactions(fetcher).await {
                    Ok(confirmed_txs) => match self.client.get_tip_hash(fetcher).await {
                        Ok(check_tip_hash) => {
                            if check_tip_hash != tip_hash {
                                tip_hash = check_tip_hash;
                                log_debug!(self.logger, "Encountered inconsistency during transaction sync, restarting.");
                                self.sync_state.borrow_mut().pending_sync = true;
                                continue;
                            }
                            num_confirmed += confirmed_txs.len() as u32;
                            self.sync_state
                                .borrow_mut()
                                .sync_confirmed_transactions(&confirmables, confirmed_txs);
                        }
                        Err(err) => {
                            log_error!(self.logger,
                                    "Failed during transaction sync, aborting. Synced so far: {} confirmed, {} unconfirmed.",
                                    num_confirmed, num_unconfirmed
                                );
                            self.sync_state.borrow_mut().pending_sync = true;
                            return Err(TxSyncError::from(err));
                        }
                    },
                    Err(InternalError::Inconsistency) => {
                        log_debug!(
                            self.logger,
                            "Encountered inconsistency during transaction sync, restarting."
                        );
                        self.sync_state.borrow_mut().pending_sync = true;
                        continue;
                    }
                    Err(err) => {
                        log_error!(self.logger,
                            "Failed during transaction sync, aborting. Synced so far: {} confirmed, {} unconfirmed.",
                            num_confirmed, num_unconfirmed
                        );
                        self.sync_state.borrow_mut().pending_sync = true;
                        return Err(TxSyncError::from(err));
                    }
                }

                let mut sync_state = self.sync_state.borrow_mut();
                sync_state.last_sync_hash = Some(tip_hash);
                sync_state.pending_sync = false;
            }
        }

        log_debug!(
            self.logger,
            "Finished transaction sync at tip {}: {} confirmed, {} unconfirmed.",
            tip_hash,
            num_confirmed,
            num_unconfirmed
        );
        Ok(())
    }

    async fn sync_best_block_updated<C: Deref>(
        &self,
        confirmables: &[C],
        tip_hash: &BlockHash,
        fetcher: &impl Fetcher,
    ) -> Result<(), InternalError>
    where
        C::Target: Confirm,
    {
        let tip_header = self.client.get_header_by_hash(fetcher, tip_hash).await?;
        let tip_status = self.client.get_block_status(fetcher, tip_hash).await?;
        if tip_status.in_best_chain {
            if let Some(tip_height) = tip_status.height {
                for c in confirmables {
                    c.best_block_updated(&tip_header, tip_height);
                }
                self.sync_state.borrow_mut().prune_output_spends(tip_height);
            }
        } else {
            return Err(InternalError::Inconsistency);
        }
        Ok(())
    }

    async fn get_unconfirmed_transactions<C: Deref>(
        &self,
        confirmables: &[C],
        fetcher: &impl Fetcher,
    ) -> Result<Vec<Txid>, InternalError>
    where
        C::Target: Confirm,
    {
        let relevant_txids = confirmables
            .iter()
            .flat_map(|c| c.get_relevant_txids())
            .collect::<HashSet<(Txid, u32, Option<BlockHash>)>>();

        let mut unconfirmed_txs = Vec::new();

        for (txid, _conf_height, block_hash_opt) in relevant_txids {
            if let Some(block_hash) = block_hash_opt {
                let block_status = self.client.get_block_status(fetcher, &block_hash).await?;
                if block_status.in_best_chain {
                    continue;
                }
                unconfirmed_txs.push(txid);
            } else {
                // Upstream panics here, but in WASM a panic crashes the entire Worker request.
                // Return an error instead — this path is unreachable for channels created with
                // LDK >= 0.0.113, which is all channels in this greenfield project.
                log_error!(self.logger, "Untracked confirmation of funding transaction. Please ensure none of your channels had been created with LDK prior to version 0.0.113!");
                return Err(InternalError::Failed);
            }
        }
        Ok(unconfirmed_txs)
    }

    async fn get_confirmed_transactions(
        &self,
        fetcher: &impl Fetcher,
    ) -> Result<Vec<ConfirmedTx>, InternalError> {
        let mut confirmed_txs: Vec<ConfirmedTx> = Vec::new();

        // Snapshot watched_transactions to avoid holding borrow across awaits.
        let watched_txs: Vec<Txid> = self
            .sync_state
            .borrow()
            .watched_transactions
            .iter()
            .copied()
            .collect();
        for txid in &watched_txs {
            if confirmed_txs.iter().any(|ctx| ctx.txid == *txid) {
                continue;
            }
            if let Some(confirmed_tx) = self.get_confirmed_tx(*txid, None, None, fetcher).await? {
                confirmed_txs.push(confirmed_tx);
            }
        }

        // Snapshot watched_outputs to avoid holding borrow across awaits.
        let watched_outputs: Vec<(bitcoin::OutPoint, WatchedOutput)> = self
            .sync_state
            .borrow()
            .watched_outputs
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        for (_, output) in &watched_outputs {
            if let Some(output_status) = self
                .client
                .get_output_status(fetcher, &output.outpoint.txid, output.outpoint.index as u64)
                .await?
            {
                if let Some(spending_txid) = output_status.txid {
                    if let Some(spending_tx_status) = output_status.status {
                        if confirmed_txs.iter().any(|ctx| ctx.txid == spending_txid) {
                            if spending_tx_status.confirmed {
                                continue;
                            } else {
                                log_trace!(self.logger,
                                    "Inconsistency: Detected previously-confirmed Tx {} as unconfirmed",
                                    spending_txid
                                );
                                return Err(InternalError::Inconsistency);
                            }
                        }

                        if let Some(confirmed_tx) = self
                            .get_confirmed_tx(
                                spending_txid,
                                spending_tx_status.block_hash,
                                spending_tx_status.block_height,
                                fetcher,
                            )
                            .await?
                        {
                            confirmed_txs.push(confirmed_tx);
                        }
                    }
                }
            }
        }

        confirmed_txs.sort_unstable_by(|tx1, tx2| {
            tx1.block_height
                .cmp(&tx2.block_height)
                .then_with(|| tx1.pos.cmp(&tx2.pos))
        });

        Ok(confirmed_txs)
    }

    async fn get_confirmed_tx(
        &self,
        txid: Txid,
        expected_block_hash: Option<BlockHash>,
        known_block_height: Option<u32>,
        fetcher: &impl Fetcher,
    ) -> Result<Option<ConfirmedTx>, InternalError> {
        if let Some(merkle_block) = self.client.get_merkle_block(fetcher, &txid).await? {
            let block_header = merkle_block.header;
            let block_hash = block_header.block_hash();
            if let Some(expected_block_hash) = expected_block_hash {
                if expected_block_hash != block_hash {
                    log_trace!(
                        self.logger,
                        "Inconsistency: Tx {} expected in block {}, but is confirmed in {}",
                        txid,
                        expected_block_hash,
                        block_hash
                    );
                    return Err(InternalError::Inconsistency);
                }
            }

            let mut matches = Vec::new();
            let mut indexes = Vec::new();
            let _ = merkle_block.txn.extract_matches(&mut matches, &mut indexes);
            if indexes.len() != 1 || matches.len() != 1 || matches[0] != txid {
                log_error!(self.logger,
                    "Retrieved Merkle block for txid {} doesn't match expectations. Please verify server integrity.",
                    txid
                );
                return Err(InternalError::Failed);
            }

            let pos = *indexes.first().unwrap() as usize;
            if let Some(tx) = self.client.get_tx(fetcher, &txid).await? {
                if tx.compute_txid() != txid {
                    log_error!(self.logger,
                        "Retrieved transaction for txid {} doesn't match expectations. Please verify server integrity.",
                        txid
                    );
                    return Err(InternalError::Failed);
                }

                // Protect against CVE-2012-2459: reject 64-byte transactions that could
                // collide with inner merkle tree nodes.
                if tx.total_size() == 64 {
                    log_error!(
                        self.logger,
                        "Skipping transaction {} due to retrieving potentially invalid tx data.",
                        txid
                    );
                    return Ok(None);
                }

                if let Some(block_height) = known_block_height {
                    return Ok(Some(ConfirmedTx {
                        tx,
                        txid,
                        block_header,
                        pos,
                        block_height,
                    }));
                }

                let block_status = self.client.get_block_status(fetcher, &block_hash).await?;
                if let Some(block_height) = block_status.height {
                    return Ok(Some(ConfirmedTx {
                        tx,
                        txid,
                        block_header,
                        pos,
                        block_height,
                    }));
                } else {
                    log_trace!(
                        self.logger,
                        "Inconsistency: Tx {} was unconfirmed during syncing.",
                        txid
                    );
                    return Err(InternalError::Inconsistency);
                }
            }
        }
        Ok(None)
    }
}

impl<L: Deref> Filter for EsploraSyncClient<L>
where
    L::Target: Logger,
{
    fn register_tx(&self, txid: &Txid, _script_pubkey: &Script) {
        let mut locked_queue = self.queue.borrow_mut();
        locked_queue.transactions.insert(*txid);
    }

    fn register_output(&self, output: WatchedOutput) {
        let mut locked_queue = self.queue.borrow_mut();
        locked_queue
            .outputs
            .insert(output.outpoint.into_bitcoin_outpoint(), output);
    }
}
