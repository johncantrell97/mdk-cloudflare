# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**mdk-cloudflare** is a library package (`mdk-cloudflare` on npm) that exports a `LightningNode` Cloudflare Durable Object class. It runs an ephemeral Lightning Network node by compiling Rust (LDK) to WASM. Consumers register the DO in their own `wrangler.toml` and call typed RPC methods from their Worker. The repo is structured as a pnpm monorepo with the Rust WASM crate and the TypeScript DO package.

## Build Commands

```bash
pnpm build          # Full build (WASM + TS packages)
pnpm build:wasm     # Build WASM only
pnpm build:packages # Build TypeScript packages only
pnpm check          # Check Rust compiles (fast feedback)
```

TypeScript tests use vitest in `packages/lightning-cloudflare/`:
```bash
cd packages/lightning-cloudflare && pnpm test
```

Rust has inline unit tests targeting `wasm32-unknown-unknown`:
```bash
wasm-pack test --node crates/ldk-wasm
```

No linting or formatting tools are configured beyond `cargo fmt` and TypeScript strict mode.

## Architecture

### Layer Stack

```
Consumer's Worker (thin router, provided by consumer)
  → LightningNode DO (packages/lightning-cloudflare/src/durable-object.ts)
    → DO ctx.storage (SQLite-backed, local reads/writes for monitor + CM persistence)
    → MdkNode (packages/lightning-cloudflare/src/index.ts) — WASM orchestration
      → WASM exports (crates/ldk-wasm/src/lib.rs) — JS-Rust boundary
        → EphemeralNode (crates/ldk-wasm/src/node.rs) — LDK restoration & lifecycle
          → LDK trait impls (chain.rs, transport.rs, persist.rs)
            → JavaScript I/O via CF primitives (fetch, connect)
    → MoneyDevKitClient (packages/lightning-cloudflare/src/client.ts) — MDK oRPC API
```

### Durable Object API

The `LightningNode` DO class provides:
- `createCheckout(options)` — Create MDK checkout + generate invoice + register
- `getCheckout(id)` — Poll checkout status from MDK API
- `pay(bolt11)` — Send outbound BOLT11 payment
- `getNodeId()` — Derive node public key
- `getNodeInfo()` — Balance and channel info
- `fetch(request)` — HTTP handler for MDK webhook callbacks

### Key Design Patterns

- **Durable Object serialization**: All node operations run through a single DO instance. The DO is keyed by a fixed name (e.g., `'default'`).
- **Ephemeral lifecycle**: Node is restored from DO storage on each request, processes events, persists inline, then drops. No background process.
- **DO storage persistence with `InProgress` contract**: `DoPersister` implements LDK's `Persist` trait and returns `ChannelMonitorUpdateStatus::InProgress`. The JS pump loop flushes pending monitor writes to `ctx.storage` between iterations, calls `storage.sync()` for durability, then signals completion via `chain_monitor.channel_monitor_updated()`. LDK is never told persistence is done until data is confirmed on disk.
- **Buffer-and-flush SocketDescriptor**: LDK's `send_data()` is sync but CF socket I/O is async. `transport.rs` buffers writes, then the JS pump loop flushes them.
- **LSPS4 protocol**: Custom message handler for JIT channel registration with an LSP.

### Consumer Integration

```ts
import { LightningNode } from 'mdk-cloudflare'
export { LightningNode }

interface Env {
  LIGHTNING_NODE: DurableObjectNamespace<LightningNode>
}

export default {
  async fetch(request: Request, env: Env) {
    const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))
    if (new URL(request.url).pathname === '/api/mdk') return node.fetch(request)
    const checkout = await node.createCheckout({ amount: 1000, currency: 'SAT' })
    return Response.json(checkout)
  }
}
```

### WASM Exports (crates/ldk-wasm/src/lib.rs)

The main entry points from TypeScript into Rust:
- `derive_node_id` — Stateless key derivation from mnemonic
- `setup_node` — Sync build phase from raw bytes (monitors + CM from DO storage, fees from Esplora)
- `initiate_connection` / `process_peer_message` — JS-driven pump loop
- `signal_monitors_persisted` — Signal to LDK that monitors are durably persisted to DO storage
- `needs_persistence` / `serialize_channel_manager` — ChannelManager persistence at session end
- `take_pending_persists` — Drain pending monitor writes (used after chain sync)
- `list_pending_monitor_updates` — Crash recovery: find interrupted InProgress updates
- `create_invoice_on_session` — Build BOLT11 invoice with LSPS4 route hint
- `sync_chain_on_session` / `flush_broadcasts_on_session` — Chain sync and tx broadcast
- `teardown_node` — Disconnect peers and drop session (no persist body)

### TypeScript Package (packages/lightning-cloudflare/)

Single package `mdk-cloudflare` containing:
- `entry.ts` — Public API barrel (package entry point)
- `durable-object.ts` — `LightningNode` DO class (public API)
- `node.ts` — `MdkNode` class, session lifecycle (internal)
- `pump-loop.ts` — JS-driven TCP pump loop (internal)
- `wasm.ts` — WASM initialization + helpers (internal)
- `storage.ts` — `NodeStorage` interface, fee refresh, monitor flushing (internal)
- `client.ts` — MDK oRPC API client (internal)
- `config.ts` — mainnet node preset (public) and internal network config values
- `log.ts` — Leveled logger (`setLogLevel` exported for consumers)
- `lnurl.ts` — LNURL resolution utilities (exported)
- `types.ts` — All TypeScript types
- `bindings.ts` — CF Workers fetch/connect bindings
- `index.ts` — Internal barrel for cross-module imports

### Rust Modules (crates/ldk-wasm/src/)

- `node.rs` — EphemeralNode: restores ChannelManager + monitors from raw bytes, runs pump loops
- `persist.rs` — DoPersister: `Persist` trait impl returning `InProgress`, in-memory buffer for JS to drain
- `events.rs` — Payment event processing (inbound claims, outbound status)
- `chain.rs` — FeeEstimator and BroadcasterInterface via Esplora HTTP
- `transport.rs` — SocketDescriptor over CF TCP `connect()`
- `sync/` — EsploraSyncClient: chain sync with reorg detection
- `lsps4/` — LSPS4 JIT channel protocol (client, messages, invoice creation)

## Key Dependencies

- **LDK fork** (`moneydevkit` org): `lightning`, `lightning-invoice`, `lightning-rapid-gossip-sync` — fork adds LSPS4 support and `accept_underpaying_htlcs`
- **wasm-bindgen**: Rust↔JS FFI for WASM

## Development Notes

- The default Cargo target is `wasm32-unknown-unknown` (set in `.cargo/config.toml`)
- `wasm-opt` is disabled in Cargo.toml profile
- `packages/ldk-wasm/` is generated by `pnpm build:wasm` and bundled into the published `mdk-cloudflare` package
- Consumer sets secrets via `wrangler secret put MNEMONIC` and `wrangler secret put MDK_ACCESS_TOKEN`
- Consumer's `wrangler.toml` migration must use `new_sqlite_classes` (not `new_classes`) for SQLite-backed DO storage
- Design docs in `docs/` describe architectural decisions in detail
- `pnpm-workspace.yaml` defines the monorepo workspace
