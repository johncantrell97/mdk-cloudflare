# mdk-cloudflare Architecture

`mdk-cloudflare` does not run a long-lived Lightning daemon inside a Worker.
It runs a request-scoped LDK session backed by Durable Object storage.

The design goal is narrow:

- keep HTTP handling in the Worker thin
- use a single Durable Object as the serialization and durability boundary
- restore only the minimum Lightning runtime needed for the current code path
- persist the result and tear the node back down

## Runtime Shape

Four layers cooperate:

1. Worker router
   Routes requests, exposes `/api/mdk`, and forwards node work to one Durable Object instance.
2. `LightningNode` Durable Object
   Owns serialized access, SQLite-backed storage, alarms, webhook handling, and the request-scoped session wrapper.
3. `MdkNode` session
   Restores LDK state from storage, performs one unit of work, persists, and destroys itself.
4. `ldk-wasm`
   Holds the core LDK types and session exports. Storage, sockets, and HTTP stay delegated to JavaScript bindings.

The important distinction is that node state is durable, but the in-memory node is not.

## Why Durable Objects

Durable Objects solve the two hard constraints in this design:

- Single-threaded serialization
  Only one operation mutates channel state at a time.
- SQLite-backed local durability
  Channel manager state, monitors, cached fees, sweepable outputs, and RGS state survive between requests.
- Alarm-driven maintenance
  Fee refresh, chain sync, and rebroadcast happen on a timer without requiring a permanently running process.

## Core Persisted State

The critical keys in Durable Object storage are:

```text
channel_manager
monitors/{channelId}
sweepable_outputs
fee_estimates
fee_estimates_updated_at
rgs_timestamp
```

These are enough to reconstruct the node session on demand.

## Sync Core, Async Edges

LDK remains synchronous. Worker I/O remains asynchronous. The bridge is explicit.

- Storage bridge
  WASM emits pending monitor writes. JavaScript flushes them to DO storage, calls `storage.sync()`, then acknowledges persistence back to WASM.
- Socket bridge
  WASM produces peer-manager bytes synchronously. The JavaScript pump loop owns the Cloudflare TCP socket and performs async reads and writes.
- HTTP bridge
  Fee estimates, chain data, RGS snapshots, and MDK requests all remain in Worker-land through `fetch()`.

The generic session shape is:

```text
setupFromStorage()
  - restore monitors + channel manager
  - refresh or reuse fee cache
  - recover in-progress monitor updates

do work
  - maybe connect to the LSP
  - maybe fetch RGS
  - maybe create or claim payments

persistSessionEnd()
  - flush monitors
  - persist channel manager
  - persist sweepable outputs
  - storage.sync()

teardown_node()
```

## Minimal Node Per Code Path

Not every API call needs a full node session.

### No node session

- `getNodeId()`
  Derives the node public key directly from the mnemonic and network preset.
- `getCheckout()`, `listProducts()`, `getCustomer()`
  Pure MDK API calls. These do not touch LDK state.

### Restore and persist only

- Invoice creation when MDK already provides `invoiceScid`
  Restore state, create the invoice locally, persist, exit.

### Restore, connect, persist

- Fresh LSPS4 invoice registration
  Restore state, connect to the LSP, obtain registration data, create the invoice, persist, exit.

### Restore, connect, claim, persist

- Webhook payment claiming
  Wake on webhook, reconnect to the LSP, claim buffered HTLCs, confirm them to MDK, persist, exit.

### Restore, fetch graph, connect, persist

- Outbound `pay()`
  Restore state, load RGS data, connect to the LSP, send payment, persist, exit.

This is the core reason the architecture fits Workers: the node does not need to stay online between requests. The LSP buffers the payment until the claim path reconnects.

## Checkout and Invoice Path

Checkout creation splits into an MDK path and a node path:

1. The Durable Object calls MDK to create or confirm the checkout.
2. If the checkout is still `UNCONFIRMED`, the path ends without creating an invoice.
3. If MDK returns `CONFIRMED`, the DO restores a node session and generates the invoice.
4. If MDK already provided `invoiceScid`, invoice creation is local.
5. If not, the session performs LSPS4 registration first.
6. The invoice is registered back to MDK, state is persisted, and the session is torn down.

## Webhook Claim Path

The receive path exists only to reconnect, claim, and confirm:

```text
MDK webhook -> Worker /api/mdk -> LightningNode.fetch()
  -> authenticate webhook secret
  -> withNode(node => node.receivePayments())
  -> setupFromStorage()
  -> timer_tick()
  -> connect() to the LSP
  -> JS pump loop processes pending HTLCs
  -> flush monitor updates and broadcasts
  -> persistSessionEnd()
  -> MDK paymentReceived(...)
  -> teardown
```

## Outbound Pay Path

The send path adds graph data, but keeps the same session discipline:

1. Restore the node session from DO storage.
2. Fetch the RGS snapshot or delta using the cached `rgs_timestamp`.
3. Connect to the LSP and finish peer/channel readiness.
4. Call into WASM to prepare and send the payment.
5. Flush broadcasts, update the cached RGS timestamp, persist, and tear down.

## Alarm Path

Maintenance is periodic rather than process-driven:

- Fee refresh
  Refresh Esplora fee estimates into DO storage so request paths usually skip inline fee fetches.
- Chain sync and rebroadcast
  Restore state, sync chain data, prepare claims, flush broadcasts, persist.
- Always rescheduled
  The alarm re-arms itself on failure so maintenance remains best-effort instead of one-shot.

## Repo Mapping

The architecture is spread across a few specific areas:

- `packages/lightning-cloudflare/src/durable-object.ts`
- `packages/lightning-cloudflare/src/route.ts`
- `packages/lightning-cloudflare/src/node.ts`
- `packages/lightning-cloudflare/src/pump-loop.ts`
- `crates/ldk-wasm/src/`

For integration guidance, use:

- `README.md`
- `CHECKOUT_PAGE_SETUP.md`
- `llms.txt`
