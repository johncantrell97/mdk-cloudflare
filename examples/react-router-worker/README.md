# React Router Worker Example

This example shows the same checkout page flow as the Vite SPA example, but mounted with `react-router-dom` and using the official MoneyDevKit checkout UI for the payment screen.

It uses:

- a Cloudflare Worker for the Lightning node and unified `/api/mdk` route
- Workers Static Assets to serve the frontend bundle
- a Vite-built React app with React Router for `/`, `/checkout/:id`, and `/success`
- `@moneydevkit/core/client` for the official MoneyDevKit checkout component

## Why this example exists

Cloudflare does not force a single frontend architecture. The package should stay Worker-first and framework-agnostic, but teams using React Router should still have a concrete reference.

This example demonstrates:

- `create_checkout`
- `get_checkout`
- `list_products`
- a custom app shell driven by React Router
- `Checkout` mounted on `/checkout/:id`
- automatic redirect into the custom success page once the invoice is settled

## Run

From the repo root:

```bash
pnpm install
cp examples/react-router-worker/.dev.vars.example examples/react-router-worker/.dev.vars
pnpm --dir examples/react-router-worker dev
```

Then:

1. Fill `examples/react-router-worker/.dev.vars` with your MoneyDevKit mnemonic and API key.
2. Set your MoneyDevKit app URL to the public base URL for this app.
3. If you are testing locally, expose `http://127.0.0.1:8787` with a tunnel such as `ngrok http 8787` and use that public URL as the app URL.

`pnpm --dir examples/react-router-worker dev` runs:

- a package build for `mdk-cloudflare`
- `vite build --watch` to emit `dist/`
- `wrangler dev` to serve the Worker plus static assets

## Deploy

From the repo root:

```bash
cd examples/react-router-worker
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
pnpm deploy
```

## Notes

- This uses the React Router library on top of static assets, not the full React Router framework/server runtime.
- Your app shell owns `/` and `/success`; the payment screen on `/checkout/:id` comes from upstream MoneyDevKit React UI.
- For the full step-by-step MDK setup flow, see [`CHECKOUT_PAGE_SETUP.md`](../../CHECKOUT_PAGE_SETUP.md).
- If you want to lift this into your own project, start by copying this example's Worker shell and installing `@moneydevkit/core`.
- This example's `package.json` uses `workspace:*` only for `mdk-cloudflare` because it runs inside this monorepo. In a standalone app, install the published package instead.
