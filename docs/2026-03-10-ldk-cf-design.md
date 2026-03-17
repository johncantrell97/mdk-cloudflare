# ldk-cf: Ephemeral Lightning Node for Cloudflare Workers

## Problem

MDK Checkout (`@moneydevkit/nextjs`) runs a Lightning node via `@moneydevkit/lightning-js`, a NAPI-RS native addon wrapping ldk-node in Rust. This produces `.node` binaries loaded via `dlopen()` — incompatible with Cloudflare Workers, which run V8 isolates without native module support, filesystem access, or persistent processes.

MDK's architecture is already ephemeral: the node sleeps until the MDK backend sends a webhook ("payment waiting"), then wakes, connects to the LSP, claims the payment, and goes back to sleep. This maps directly to the Cloudflare Worker request/response lifecycle.

## Solution

Build `ldk-cf`, a Rust WASM library that wraps the `lightning` crate (not ldk-node) with Cloudflare-native I/O. It compiles to `wasm32-unknown-unknown`, exports a minimal API via `wasm-bindgen`, and delegates all I/O to JavaScript callbacks that use Cloudflare primitives (`connect()` for TCP, `fetch()` for HTTP, KV/D1 for storage).

## Architecture

```
MDK Backend                    Cloudflare Worker              LSP
    |                               |                          |
    |-- webhook: payment waiting -->|                          |
    |                               | 1. Load WASM + state     |
    |                               | 2. connect() TCP :9735 ->|
    |                               | 3. BOLT 8 handshake      |
    |                               | 4. Claim HTLC            |
    |                               | 5. Persist state to KV   |
    |                               | 6. Close connection      |
    |<-- confirm payment -----------|                          |
    |                               | (Worker dies)            |
```

No Durable Objects. No bridge services. No WebSocket proxies. Plain Cloudflare Worker with `connect()` for direct TCP to the LSP.

## Key Design Decisions

### Why not ldk-node?

ldk-node bundles tokio (multi-threaded), rusqlite, lightning-net-tokio (TCP via tokio::net), and a background event loop. All are WASM-incompatible. Forking and feature-gating would touch ~50% of the codebase with ongoing merge conflict burden.

### Why `lightning` crate directly?

The core `lightning` crate is runtime-agnostic and supports `no_std`. It defines traits (`SocketDescriptor`, `Persist`, `BroadcasterInterface`, `FeeEstimator`, `Logger`) that consumers implement with their own I/O. This is exactly the extension point we need.

### Why `connect()` instead of WebSocket?

Cloudflare Workers have a GA TCP sockets API (`import { connect } from 'cloudflare:sockets'`). Port 9735 is not blocked. This gives raw byte streams — BOLT 8's Noise_XK protocol runs directly over it. No bridge service needed. WebSocket would only work with CLN nodes (`--websocket-port`), limiting connectivity.

### Why no Durable Objects?

MDK's LSPS4 protocol is designed for offline nodes. The LSP stores incoming HTLCs and sends webhooks. The node only needs to be alive for seconds to claim payments. A plain Worker handles this — no persistent state or connections required beyond the single request.

### LSPS4 Protocol

MDK uses a custom protocol (LSPS4, in their rust-lightning fork) for JIT channels with offline nodes:

1. Client registers once with LSP via `lsps4.register_node` JSON-RPC message
2. LSP assigns a persistent intercept SCID
3. Client creates invoices using that SCID as a route hint
4. When payment arrives, LSP stores HTLC and sends webhook
5. Client wakes, connects, LSP forwards stored HTLCs
6. Client claims with preimage, goes back to sleep

The client side of LSPS4 is small (~200 lines): one message type, one event, invoice creation with LSP route hints.

## Crate Structure

```
ldk-cf/
  Cargo.toml
  src/
    lib.rs              # wasm_bindgen exports (4 functions)
    node.rs             # EphemeralNode: restore/connect/claim/persist lifecycle
    transport.rs        # SocketDescriptor impl (buffer + async flush over connect())
    chain.rs            # FeeEstimator + BroadcasterInterface (Esplora via fetch)
    store.rs            # Persist + KVStore impl (JS callbacks -> CF KV)
    logger.rs           # Logger impl (JS callback)
    events.rs           # Event handler: PaymentClaimable -> claim_funds()
    config.rs           # UserConfig with MDK defaults
    lsps4/
      mod.rs
      msgs.rs           # lsps4.register_node request/response types
      client.rs         # LSPS4 client: send register_node, handle response
      invoice.rs        # Create BOLT11 invoice with LSP route hint + intercept SCID
```

## Dependencies

```toml
lightning = { git = "https://github.com/moneydevkit/rust-lightning", branch = "lsp-0.2.0",
              default-features = false, features = ["no-std"] }
lightning-invoice = { git = "https://github.com/moneydevkit/rust-lightning", branch = "lsp-0.2.0" }
bitcoin = { version = "0.32", default-features = false }
bip39 = { version = "2.0", features = ["alloc"] }
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
js-sys = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
getrandom = { version = "0.3", features = ["wasm_js"] }
```

Not included (and why):
- `tokio` — async driven by `wasm-bindgen-futures`, I/O pump is a simple loop
- `rusqlite` — state persisted to Cloudflare KV via JS callbacks
- `lightning-net-tokio` — replaced by `connect()` via `SocketDescriptor` impl
- `lightning-background-processor` — no background tasks, manual event pump
- `lightning-rapid-gossip-sync` — receive-only node doesn't need network graph
- `bdk_wallet` — on-chain wallet handled by LSP, no UTXO management needed
- `lightning-liquidity` — LSPS4 client is small enough to implement inline

## JS-WASM Boundary

Rust receives I/O capabilities from JavaScript as duck-typed objects via `wasm_bindgen`:

```rust
#[wasm_bindgen]
extern "C" {
    // Storage (Cloudflare KV or D1)
    pub type JsStore;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn get(this: &JsStore, key: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn put(this: &JsStore, key: &str, value: &[u8]) -> Result<(), JsValue>;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn delete(this: &JsStore, key: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn list(this: &JsStore, prefix: &str) -> Result<JsValue, JsValue>;

    // TCP socket (from cloudflare:sockets connect())
    pub type JsSocket;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn read(this: &JsSocket) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn write(this: &JsSocket, data: &[u8]) -> Result<(), JsValue>;
    #[wasm_bindgen(structural, method)]
    pub fn close(this: &JsSocket);

    // HTTP client (wraps fetch())
    pub type JsFetcher;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn get_json(this: &JsFetcher, url: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(structural, method, catch)]
    pub async fn post_bytes(this: &JsFetcher, url: &str, body: &[u8]) -> Result<JsValue, JsValue>;
}
```

JavaScript provides these as plain objects wrapping Cloudflare APIs:

```typescript
const store = {
  get: async (key) => { /* env.KV.get() */ },
  put: async (key, value) => { /* env.KV.put() */ },
  delete: async (key) => { /* env.KV.delete() */ },
  list: async (prefix) => { /* env.KV.list() */ },
}

const connectTcp = async (host, port) => {
  const socket = connect({ hostname: host, port }, { secureTransport: 'off' })
  await socket.opened
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  return {
    read: async () => { const { value, done } = await reader.read(); return done ? null : value },
    write: async (data) => { await writer.write(data) },
    close: () => { socket.close() },
  }
}
```

## LDK Trait Implementations

| LDK Trait | Implementation | Backing I/O |
|-----------|---------------|-------------|
| `SocketDescriptor` | `CfSocketDescriptor` — buffers `send_data()` synchronously, flushes async in pump loop | `JsSocket` (CF `connect()`) |
| `Persist` | `KvPersister` — serializes `ChannelMonitor` bytes to KV | `JsStore` (CF KV) |
| `BroadcasterInterface` | `EsploraBroadcaster` — POST to `/tx` | `JsFetcher` (CF `fetch()`) |
| `FeeEstimator` | `EsploraFeeEstimator` — GET `/fee-estimates`, cached per invocation | `JsFetcher` (CF `fetch()`) |
| `Logger` | `JsLogger` — calls JS callback | `console.log` |
| `EntropySource` + `NodeSigner` + `SignerProvider` | `KeysManager` (LDK built-in) | `crypto.getRandomValues()` via `getrandom/wasm_js` |

### SocketDescriptor Sync/Async Bridge

LDK's `SocketDescriptor::send_data()` is synchronous, but Cloudflare sockets are async. Solution: buffer-and-flush.

`CfSocketDescriptor` does NOT hold a `JsSocket` reference. It holds only a numeric ID, an outbound byte buffer (`RefCell<Vec<u8>>`), and a disconnected flag. The `JsSocket` lives in the async pump loop on the JS/Rust boundary and is never stored in the descriptor. This avoids `Send + Sync` issues entirely — WASM is single-threaded, so `RefCell` is safe, and LDK's `Send + Sync` bounds are satisfied via `unsafe impl` (sound because WASM has no threads).

```rust
#[derive(Clone)]
pub struct CfSocketDescriptor {
    id: u64,
    outbound_buffer: Rc<RefCell<Vec<u8>>>,  // Rc+RefCell, not Arc+Mutex — single-threaded WASM
    disconnected: Rc<Cell<bool>>,
}

// Sound: WASM is single-threaded, these will never cross thread boundaries.
unsafe impl Send for CfSocketDescriptor {}
unsafe impl Sync for CfSocketDescriptor {}

impl SocketDescriptor for CfSocketDescriptor {
    fn send_data(&mut self, data: &[u8], _resume_read: bool) -> usize {
        self.outbound_buffer.borrow_mut().extend_from_slice(data);
        data.len()
    }
    fn disconnect_socket(&mut self) {
        self.disconnected.set(true);
    }
}
```

The async pump loop drives data between the socket and PeerManager. The `JsSocket` is owned by the pump loop, not the descriptor:

```
// pump loop owns JsSocket, descriptor is just an ID + buffer
loop {
  // Drain the descriptor's outbound buffer and write to JsSocket
  let data = descriptor.take_buffered();
  if !data.is_empty() { socket.write(&data).await; }

  // Read from JsSocket, feed to PeerManager
  match socket.read().await {
    Some(bytes) => peer_manager.read_event(&descriptor, &bytes),
    None => break, // socket closed
  }

  peer_manager.process_events();
  channel_manager.process_pending_events();  // claim HTLCs here
  persister.flush_pending_persists(store, chain_monitor).await;
  if no events fired for 5 seconds: break
  if total elapsed > 30 seconds: break  // safety timeout
}
```

### Persist Trait Sync/Async Bridge

LDK's `Persist` trait is synchronous, but KV writes are async. Solution: return `InProgress` and flush in the pump loop.

`KvPersister` buffers serialized `ChannelMonitor` data synchronously, returning `ChannelMonitorUpdateStatus::InProgress`. The pump loop calls an async `flush_pending_persists()` method after each event processing round, which writes buffered data to KV via `JsStore::put()`. After successful flush, `chain_monitor.channel_monitor_updated()` is called to notify LDK that persistence completed.

```rust
impl Persist<InMemorySigner> for KvPersister {
    fn persist_new_channel(&self, id: MonitorName, monitor: &ChannelMonitor<..>) -> ChannelMonitorUpdateStatus {
        let bytes = monitor.encode();
        let update_id = monitor.get_latest_update_id();
        self.pending_writes.borrow_mut().push((id, bytes, update_id));
        ChannelMonitorUpdateStatus::InProgress  // flushed async in pump loop
    }

    fn update_persisted_channel(&self, id: MonitorName, _update: Option<&ChannelMonitorUpdate>,
                                 monitor: &ChannelMonitor<..>) -> ChannelMonitorUpdateStatus {
        let bytes = monitor.encode();
        let update_id = monitor.get_latest_update_id();
        self.pending_writes.borrow_mut().push((id, bytes, update_id));
        ChannelMonitorUpdateStatus::InProgress
    }

    fn archive_persisted_channel(&self, id: MonitorName) {
        self.pending_deletes.borrow_mut().push(id);
    }
}

// Called in the pump loop after event processing:
impl KvPersister {
    pub async fn flush_pending_persists(&self, store: &JsStore, chain_monitor: &ChainMonitor<..>) -> Result<(), JsValue> {
        for (id, bytes, update_id) in self.pending_writes.borrow_mut().drain(..) {
            store.put(&format!("monitors/{}", id), &bytes).await?;
            chain_monitor.channel_monitor_updated(id, update_id)?;
        }
        for id in self.pending_deletes.borrow_mut().drain(..) {
            store.delete(&format!("monitors/{}", id)).await?;
        }
        Ok(())
    }
}
```

This pattern is safe because: (a) `claim_funds()` releases the preimage to the peer via PeerManager, and (b) the monitor update is persisted before the pump loop ends, so if the Worker dies mid-flush, LDK will replay the event on next restore (events are crash-safe by design).

**ChannelManager serialization**: After the pump loop exits (all events processed, persist flushed), the `ChannelManager` is serialized and written to KV as a final step before the Worker returns. This must happen after monitor flush — LDK requires that monitors are at least as up-to-date as the `ChannelManager` for crash safety. The full persist sequence is:

1. Pump loop exits (quiet for 5 seconds or timeout)
2. `flush_pending_persists()` — write all buffered monitors to KV
3. Serialize `ChannelManager` and write to `channel_manager` key in KV
4. Disconnect peer, return result

## Exported WASM API

Four functions cover all use cases:

### `handle_payment_webhook` — the hot path

Called when MDK backend sends webhook notification that a payment is waiting.

1. Restore `ChannelManager` + `ChannelMonitor`s from KV
2. Sync chain state via Esplora (`Confirm` interface)
3. Connect to LSP via `connect()` on port 9735
4. LSP forwards stored HTLCs -> `PaymentClaimable` events fire
5. Extract preimage from `PaymentPurpose` (auto-derived by LDK from `create_inbound_payment()`) and call `claim_funds(preimage)` -> preimage sent back to LSP
6. Persist updated state to KV
7. Disconnect and return claimed payments

### `register_and_create_invoice` — first-time or SCID refresh

1. Restore node from KV
2. Connect to LSP
3. Send `lsps4.register_node` custom message
4. Receive `InvoiceParametersReady` with intercept SCID + CLTV delta
5. Persist SCID for future use
6. Create BOLT11 invoice with LSP route hint using intercept SCID
7. Return invoice string

### `create_invoice_with_scid` — fast path, no connection needed

1. Restore node from KV
2. Load persisted SCID from previous registration
3. Create BOLT11 invoice with LSP route hint
4. Return invoice string (no peer connection required)

### `derive_node_id` — stateless utility

Pure key derivation from mnemonic. No state restoration or I/O needed.

## LSPS4 Client Implementation

Implemented inline (~200 lines) rather than depending on `lightning-liquidity`. The client side consists of:

**Message types** (`lsps4/msgs.rs`):
- `RegisterNodeRequest` — empty JSON-RPC params
- `RegisterNodeResponse` — `{ jit_channel_scid, lsp_cltv_expiry_delta }`
- Serialized as LSPS0 custom messages (type 37913)

**Client handler** (`lsps4/client.rs`):
- `send_register_node(peer_manager, lsp_pubkey)` — sends the JSON-RPC request
- `handle_response(message)` — parses response, returns `Lsps4Registration`
- Implements `CustomMessageHandler` for PeerManager integration

**Invoice creation** (`lsps4/invoice.rs`):
- `create_jit_invoice(channel_manager, intercept_scid, cltv_delta, amount, expiry)`
- Calls `channel_manager.create_inbound_payment()` for payment hash + secret
- Builds BOLT11 invoice with LSP route hint using the intercept SCID
- Sets `min_final_cltv_expiry = cltv_delta + 2`

## ChannelManager Configuration

Uses MDK's custom rust-lightning fork settings:

```rust
let mut config = UserConfig::default();
config.channel_handshake_config.min_their_channel_reserve_satoshis = 0; // Full withdrawal
config.accept_intercept_htlcs = true;
config.manually_accept_inbound_channels = true; // For JIT channels
```

The `accept_underpaying_htlcs` flag is set in the rust-lightning fork itself (branch `lsp-0.2.0`).

## State Persistence

All state stored in Cloudflare KV under namespaced keys:

| Key Pattern | Data | Updated When |
|------------|------|-------------|
| `channel_manager` | Serialized `ChannelManager` | Every webhook invocation |
| `monitors/{channel_id}` | Serialized `ChannelMonitor` | Channel state changes (via `Persist` flush) |
| `lsps4_scid` | `{ intercept_scid, cltv_expiry_delta }` | `register_node` response |
| `last_block` | `{ hash, height }` | Every chain sync |
| `sweepable_outputs` | Serialized `SpendableOutputDescriptor`s | Force-close detected |
| `network_graph` | Not stored — receive-only node doesn't need it | Never |
| `scorer` | Not stored — not routing payments | Never |

## Chain Synchronization

Uses LDK's `Confirm` interface (not `Listen`):

1. On wake, load last-seen block hash/height from KV (`last_block` key)
2. Fetch current chain tip from Esplora
3. If blocks have been mined since last wake:
   a. For each block since last-seen, fetch block header and any transactions matching registered outputs/scripts via Esplora
   b. Call `transactions_confirmed(header, txdata, height)` for any relevant transactions (channel closes, HTLC settlements)
   c. Call `transaction_unconfirmed(txid)` for any previously-confirmed transactions no longer in the best chain (reorgs)
   d. Call `best_block_updated(header, height)` on both `ChannelManager` and `ChainMonitor`
4. Persist new `last_block` to KV

**Force-close safety**: If the LSP force-closes a channel while the node is offline, the closing transaction will be detected during step 3b via registered outputs from the `ChainMonitor`. LDK will generate `SpendableOutputs` events for sweepable funds. Since this is a receive-only node without an on-chain wallet, these events are logged and the sweep transaction data is persisted to KV for out-of-band handling (the operator can broadcast the sweep via any Bitcoin wallet).

In practice, force-closes are rare for active LSP relationships. The node's registered `Filter` outputs (populated during `ChannelMonitor` restoration) tell us exactly which transactions to query from Esplora, keeping sync lightweight even after extended offline periods.

## Binary Size

| Component | Estimated Size |
|-----------|---------------|
| `lightning` (no-std, no routing) | ~1.5-2 MB |
| `bitcoin` + `secp256k1` | ~400 KB |
| `lightning-invoice` | ~100 KB |
| `bip39` | ~100 KB |
| `serde_json` | ~300 KB |
| wasm-bindgen glue | ~50 KB |
| **Total uncompressed** | **~2.5-3 MB** |
| **gzip compressed** | **~1.2-1.5 MB** |

Cloudflare paid plan allows 10MB compressed. This fits comfortably.

Build optimization: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`, plus post-build `wasm-opt -Oz`.

## TypeScript Package

A companion `@moneydevkit/cloudflare` npm package wraps the WASM module:

```typescript
// worker.ts
import { handleWebhook, createInvoice, deriveNodeId } from '@moneydevkit/cloudflare'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.url.endsWith('/webhook')) {
      const claimed = await handleWebhook({
        store: env.KV,
        mnemonic: env.MDK_MNEMONIC,
        lspPubkey: env.MDK_LSP_PUBKEY,
        lspAddr: env.MDK_LSP_ADDR,
        webhookBody: await request.json(),
      })
      return Response.json({ claimed })
    }
  }
}
```

The package handles:
- WASM module instantiation and caching
- Wrapping Cloudflare KV as `JsStore`
- Wrapping `connect()` as `JsSocket`
- Wrapping `fetch()` as `JsFetcher`
- Re-exporting MDK core client-side hooks (checkout, products, etc.)

## What This Does NOT Include

- **On-chain wallet** — LSP manages channel opens/closes
- **Payment sending** — receive-only node
- **Network graph / routing** — LSP routes on our behalf
- **Gossip sync** — not needed for single-LSP receive-only
- **Background processing** — no long-running tasks
- **Multiple peer connections** — only connects to one LSP
- **Tor / proxy support** — direct TCP to LSP

## Error Handling and Recovery

### Preimage Source

Invoices are created via `channel_manager.create_inbound_payment()`, which generates a payment hash deterministically from the `ChannelManager`'s secret key material. When `PaymentClaimable` fires, the preimage is available in `PaymentPurpose::Bolt11InvoicePayment { payment_preimage: Some(preimage), .. }` — LDK auto-derives it. We never use `create_inbound_payment_for_hash()` (which requires external preimage management).

### Worker Dies Mid-Claim

If the Worker is killed after `claim_funds(preimage)` but before `ChannelMonitor` state is flushed to KV:
- The preimage has already been sent to the LSP via PeerManager (the peer message is sent synchronously in `claim_funds`).
- On next restore, the `ChannelManager` will replay `PaymentClaimable` (events are idempotent). Calling `claim_funds` again is a no-op if the HTLC was already resolved.
- The `ChannelMonitor` may be slightly stale, but LDK's crash recovery design handles this — monitors are designed to be behind the channel state, and the protocol resolves conflicts on-chain if needed.

### KV Write Failure

If `JsStore::put()` fails during `flush_pending_persists()`:
- The pump loop returns an error to the Worker, which returns a non-200 response.
- The MDK backend retries the webhook (standard webhook retry logic).
- On retry, the node restores from the last successfully persisted state and replays.

### LSP Unreachable

If `connect()` fails or the BOLT 8 handshake times out:
- Return error to the Worker, which returns a non-200 response.
- MDK backend retries the webhook.
- The HTLC remains stored at the LSP (LSPS4 stores HTLCs for up to 45 seconds before failing them).

### Concurrent Webhooks

MDK's backend must serialize webhook deliveries per node (by mnemonic/node_id). Concurrent webhook invocations for the same node would cause state corruption — two Workers restoring the same `ChannelManager` from KV and writing back conflicting states. This is already the case in the Next.js implementation (webhooks are processed sequentially per node). The MDK backend enforces this.

If additional safety is needed, the Worker can use a KV-based advisory lock: write a `lock/{node_id}` key with TTL before processing, check for its existence at the start, and delete on completion. This is best-effort but prevents most races.

## no_std and std Coexistence

The `lightning` crate is compiled with `features = ["no-std"]`, meaning it uses only `core` and `alloc`. The `wasm32-unknown-unknown` target ships with full `std`, so other crates (`serde_json`, `wasm-bindgen`) use `std` freely. This is not a conflict — `no_std` crates run fine on `std` targets. The `no_std` feature on `lightning` simply avoids pulling in `std::net`, `std::fs`, etc., which is exactly what we want.

For `getrandom`: the `lightning` crate and `bitcoin`/`secp256k1` may transitively depend on `getrandom` 0.2.x. We enable `getrandom = { version = "0.2", features = ["js"] }` in the final binary crate to cover transitive dependencies. If the `lightning` fork uses `getrandom` 0.3.x, we add that too with `features = ["wasm_js"]`. Both can coexist in the dependency tree.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| WASM binary too large | Aggressive size optimization; strip routing/scoring. Mutiny achieved ~8MB with full routing; we strip that, targeting ~3MB uncompressed. CF paid plan allows 10MB compressed |
| `lightning` crate `no_std` compilation issues | Mutiny proved this works (they shipped a production WASM wallet). Pin to known-good revision of MDK's fork |
| `SocketDescriptor` buffer/flush timing | Test with real LSP; add configurable pump loop timing. Mutiny used same buffer-and-flush pattern successfully |
| Chain sync too slow on cold start | Cache `last_block` in KV. For a receive-only node, only registered outputs need checking — typically zero transactions to process |
| CF Worker CPU timeout (5 min paid) | Payment claiming takes seconds, not minutes. Well within limits |
| MDK's rust-lightning fork diverges from upstream | Pin to specific git commit, not branch |
| KV eventual consistency | MDK backend serializes webhooks per node, so no concurrent reads of stale state. For additional safety, use KV advisory locking |
| WASM memory (128MB limit) | ChannelManager + monitors for a single-LSP node with few channels is well under 10MB. No network graph or scorer in memory |
| `CustomMessageHandler` generic complexity | Define a concrete `PeerManager` type alias with all generics resolved; the LSPS4 handler is one of the type parameters |
