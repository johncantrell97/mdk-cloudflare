# Checkout Page Setup

This guide covers the two checkout page examples:

- [`examples/react-vite-worker/`](examples/react-vite-worker/)
- [`examples/react-router-worker/`](examples/react-router-worker/)

Both examples share the same backend shape:

- a Cloudflare Worker
- the `LightningNode` Durable Object from `mdk-cloudflare`
- the unified `/api/mdk` route
- a React frontend served with Workers Static Assets

The only difference is the frontend router layer.

## Fastest New-Project Path

If you want a new app, start from one of the example directories:

- `examples/react-vite-worker` for a minimal React SPA shell
- `examples/react-router-worker` for a React Router shell
- `examples/basic-worker` for backend-only Worker usage

Treat those examples as copyable reference apps, not as framework requirements.

## Before You Start

You need:

- a Cloudflare account and Wrangler auth
- a MoneyDevKit account, or credentials created with `npx @moneydevkit/create`
- your MoneyDevKit `api_key`
- your MoneyDevKit mnemonic
- `pnpm install` already run at the repo root

Official references checked while tightening this guide:

- MoneyDevKit Next.js setup: https://docs.moneydevkit.com/nextjs
- MoneyDevKit troubleshooting: https://docs.moneydevkit.com/troubleshooting
- Cloudflare local secrets with `.dev.vars`: https://developers.cloudflare.com/workers/local-development/environment-variables/

## 1. Choose an Example

Use:

- `examples/react-vite-worker` if you want the thinnest possible React SPA shell
- `examples/react-router-worker` if you want `react-router-dom` to own the routes

Both use the same frontend shape:

- a small app shell you own
- the official MoneyDevKit React checkout component from `@moneydevkit/core/client`

## 2. Add Local Secrets

Each example includes a `.dev.vars.example`.

Copy it next to that example's `wrangler.toml`:

```bash
cp examples/react-vite-worker/.dev.vars.example examples/react-vite-worker/.dev.vars
```

or:

```bash
cp examples/react-router-worker/.dev.vars.example examples/react-router-worker/.dev.vars
```

Then fill in:

- `MNEMONIC`: your MoneyDevKit mnemonic
- `MDK_ACCESS_TOKEN`: your MoneyDevKit API key

Important:

- the worker expects the seed phrase in `MNEMONIC`, not `MDK_MNEMONIC`
- for local development, Wrangler loads secrets from `.dev.vars`
- for deployed Workers, set secrets with `wrangler secret put`

## 3. Point MoneyDevKit at Your App

MoneyDevKit expects your app to expose `/api/mdk`. In these examples, that route is handled by the Worker.

In the MoneyDevKit dashboard:

1. Set your app URL to the public base URL where the Worker app is reachable.
2. If you want to test product checkouts, create products in the MoneyDevKit dashboard first.

Examples of valid app URLs:

- deployed Worker: `https://your-app.your-domain.com`
- local tunnel: `https://abc123.ngrok-free.app`

The MoneyDevKit app URL should be the base origin, not the full `/api/mdk` path.

Important distinction:

- the built-in `/api/mdk` route uses `MDK_ACCESS_TOKEN` for secret-authenticated MDK server traffic
- MoneyDevKit Standard Webhooks for app-level events such as `checkout.completed` are a separate integration and should use their own endpoint and `whsec_...` signing secret

## 4. Run Locally

First authenticate Wrangler if needed:

```bash
pnpm exec wrangler login
```

Then start one example:

```bash
pnpm --dir examples/react-vite-worker dev
```

or:

```bash
pnpm --dir examples/react-router-worker dev
```

That starts:

- `vite build --watch` for the frontend bundle
- `wrangler dev` for the Worker and static assets

The local Worker normally runs on `http://127.0.0.1:8787`.

## 5. Make Local Development Reachable by MoneyDevKit

MoneyDevKit needs a public URL so it can call back into your app to complete payments. `localhost` is not enough.

Use a tunnel such as:

```bash
ngrok http 8787
```

Then update your MoneyDevKit app URL to the tunnel origin, for example:

```text
https://abc123.ngrok-free.app
```

After that, open the same public URL in your browser and test the checkout flow there, not the raw localhost URL.

## 6. Deploy

Set production secrets in the example directory you are deploying:

```bash
cd examples/react-vite-worker
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
pnpm deploy
```

or:

```bash
cd examples/react-router-worker
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
pnpm deploy
```

After deploy:

1. Copy the deployed Worker URL.
2. Set the MoneyDevKit app URL to that base URL.
3. Retry a checkout.

## 7. Copy This into Your Own Project

Today, the easiest path is to start from one example and copy the pieces you need.

Worker side:

- copy [`examples/react-vite-worker/worker.ts`](examples/react-vite-worker/worker.ts) or [`examples/react-router-worker/worker.ts`](examples/react-router-worker/worker.ts)
- copy the Durable Object binding and `[assets]` section from that example's `wrangler.toml`

Frontend side:

- copy the chosen example's `src/main.tsx`, `src/App.tsx`, and `index.html`
- install `@moneydevkit/core`, `react`, and `react-dom`
- import `@moneydevkit/core/mdk-styles.css`
- mount `Checkout` from `@moneydevkit/core/client` on your `/checkout/:id` route
- use `useCheckout` and `useProducts` in your app shell to create checkouts

Important:

- the example `package.json` files use `workspace:*` because they are developed inside this monorepo
- in your own app, install published packages instead of copying those `workspace:*` dependency entries verbatim
- for a standalone Vite React app, install `mdk-cloudflare`, `@moneydevkit/core`, `react`, and `react-dom`
- for a standalone React Router app, also install `react-router-dom`

## Existing App Quick Path

If you already have a Vite React or React Router app, the intended path is:

1. install `mdk-cloudflare` and `@moneydevkit/core`
2. copy the relevant Worker shape from one of the examples
3. mount `Checkout` from `@moneydevkit/core/client` on your checkout route, and use `useCheckout` / `useProducts` in your own app shell
4. set your MoneyDevKit app URL to your app's public base origin

If you are using a coding agent, point it at:

- [`llms.txt`](llms.txt)
- [`CHECKOUT_PAGE_SETUP.md`](CHECKOUT_PAGE_SETUP.md)
- the closest example directory

That works better than a rigid installer because Cloudflare app structures vary too much across projects.

## Common Failure Modes

- Checkout loads but payment never completes:
  your MoneyDevKit app URL is wrong or not publicly reachable
- Product list is empty:
  you have not created products in the MoneyDevKit dashboard yet
- Local dev cannot read secrets:
  you added `wrangler secret put` but did not create `.dev.vars`
- Webhook auth fails:
  the inbound MDK request to `/api/mdk` is not using your `MDK_ACCESS_TOKEN`
