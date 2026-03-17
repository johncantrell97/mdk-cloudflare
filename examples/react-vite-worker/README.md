# React + Vite Worker Example

This example shows one concrete way to host checkout pages with `mdk-cloudflare` without committing the package itself to a framework.

It uses:

- a Cloudflare Worker for the Lightning node and unified `/api/mdk` route
- Workers Static Assets to serve the frontend bundle
- a Vite-built React SPA for the app shell
- `@moneydevkit/core/client` for the official MoneyDevKit checkout UI

## Why this example exists

Cloudflare has a much wider frontend design space than Next.js. The package should stay framework-agnostic, but users still need a working reference they can copy from.

This example demonstrates:

- `create_checkout`
- `get_checkout`
- `list_products`
- a custom app shell for `/` and `/success`
- `Checkout` from `@moneydevkit/core/client` on `/checkout/:id`
- automatic redirect into the custom success page once the invoice is settled

## Run

From the repo root:

```bash
pnpm install
cp examples/react-vite-worker/.dev.vars.example examples/react-vite-worker/.dev.vars
pnpm --dir examples/react-vite-worker dev
```

Then:

1. Fill `examples/react-vite-worker/.dev.vars` with your MoneyDevKit mnemonic and API key.
2. Set your MoneyDevKit app URL to the public base URL for this app.
3. If you are testing locally, expose `http://127.0.0.1:8787` with a tunnel such as `ngrok http 8787` and use that public URL as the app URL.

`pnpm --dir examples/react-vite-worker dev` runs:

- a package build for `mdk-cloudflare`
- `vite build --watch` to emit `dist/`
- `wrangler dev` to serve the Worker plus static assets

## Deploy

From the repo root:

```bash
cd examples/react-vite-worker
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
pnpm deploy
```

## Notes

- The frontend shell here is intentionally small and explicit. Your app owns `/` and `/success`; the payment screen is the upstream `Checkout` component.
- This example is optimized for minimal assumptions. If you want route-aware integration, see `examples/react-router-worker/`.
- For the full step-by-step MDK setup flow, see [`CHECKOUT_PAGE_SETUP.md`](../../CHECKOUT_PAGE_SETUP.md).
- If you want to lift this into your own project, copy this example's Worker shell and install `@moneydevkit/core`.
- This example's `package.json` uses `workspace:*` only for `mdk-cloudflare` because it runs inside this monorepo. In a standalone app, install the published package instead.
