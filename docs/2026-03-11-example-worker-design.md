# ldk-cf Example Worker — Design Spec

**Goal:** A Cloudflare Worker that demonstrates ldk-cf usage — ephemeral Lightning node with invoice generation and LSP webhook handling.

**Architecture:** Single CF Worker with Hono routing, KV for all node state, inline HTML landing page. Mainnet only.

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Landing page — node ID, network, invoice form |
| `/api/invoice` | POST | Generate BOLT11 invoice (amount_sats in body) |
| `/webhook` | POST | LSP callback — wake node, claim payments |

## Bindings

- **KV:** `LDK_STATE` — all node/channel state via ldk-cf's `createStore()`
- **Secrets:** `MNEMONIC` (BIP-39), `LSP_PUBKEY`, `LSP_HOST`
- **Vars:** `ESPLORA_URL` (default: `https://mempool.space/api`)

## Invoice Flow

1. `POST /api/invoice` receives `{ amount_sats: number }`
2. Try `createInvoice()` first (fast path — uses stored SCID, no LSP connection)
3. If fails (no SCID registered), fall back to `registerAndCreateInvoice()` (connects to LSP)
4. Return `{ invoice: "lnbc..." }`

## Landing Page

Minimal inline HTML. Shows:
- Node public key (derived from mnemonic at request time)
- Network: mainnet
- Form: amount input + "Generate Invoice" button
- Invoice display area with QR code (client-side rendering)

## Stack

- Hono for routing
- No frontend build — HTML served as template string from Worker
- QR code: lightweight client-side library (qrcode-generator or similar inline SVG)
- wrangler for dev/deploy
