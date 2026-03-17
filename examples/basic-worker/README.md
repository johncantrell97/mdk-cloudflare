# Basic Worker Example

A complete Cloudflare Worker that uses `mdk-cloudflare` to accept and send Lightning payments, with a built-in HTML dashboard.

## Routes

| Method | Path | Description |
|---|---|---|
| GET | `/` | Dashboard UI |
| POST | `/api/checkout` | Create a checkout |
| GET | `/api/checkout/:id` | Poll checkout status |
| POST | `/api/pay` | Pay a BOLT11 invoice |
| GET | `/api/info` | Node balance and channels |
| GET | `/api/node-id` | Node public key |
| GET | `/api/debug` | Debug info (config, chain tip, channels) |
| POST | `/api/mdk` | MDK webhook handler (called by MDK servers) |

## Setup

```bash
# From the repo root
pnpm install
pnpm build

# Create local secrets for wrangler dev
cp examples/basic-worker/.dev.vars.example examples/basic-worker/.dev.vars

# Run locally
cd examples/basic-worker
wrangler dev

# Deploy
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
wrangler deploy
```

Then fill `examples/basic-worker/.dev.vars` with your MoneyDevKit mnemonic and API key.

## Files

- `worker.ts` — HTTP router, forwards requests to the LightningNode DO
- `dashboard.ts` — Server-rendered HTML dashboard
- `wrangler.toml` — Cloudflare configuration (DO binding, SQLite migration)

## Notes

- The Worker is a thin HTTP router. All Lightning logic lives in the `LightningNode` Durable Object from `mdk-cloudflare`.
- `LightningNode` must be re-exported from the Worker entry point so the CF runtime can instantiate it.
- Uses `new_sqlite_classes` (not `new_classes`) in the migration — the DO requires SQLite-backed storage.
- The public release currently supports only mainnet.
- For local development, use `.dev.vars`. `wrangler secret put` is for deployed Workers.
