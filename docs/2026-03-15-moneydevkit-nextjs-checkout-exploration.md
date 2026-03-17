# MoneyDevKit Next.js Checkout Exploration

## Goal

Understand what `@moneydevkit/nextjs` actually ships, which parts are reusable in a Cloudflare Worker environment, and what `ldk-cf` would need in order to offer the same checkout pages or built-in checkout pages for worker users.

## Scope Investigated

- Published package metadata for `@moneydevkit/nextjs@0.14.0`
- Source for `moneydevkit/mdk-checkout`
  - `packages/nextjs`
  - `packages/core`
  - `packages/api-contract`
- Current `ldk-cf` implementation in this repo

## Executive Summary

`@moneydevkit/nextjs` is not the checkout system itself. It is a thin Next.js adapter around `@moneydevkit/core`.

The actual checkout page behavior lives in `@moneydevkit/core`:

- React checkout UI
- CSS bundle
- client hooks
- `/api/mdk` unified route contract
- signed checkout URL helpers
- checkout confirmation flow

The server side of that flow still depends on Node-native `@moneydevkit/lightning-js`, so it cannot be reused directly in Cloudflare Workers.

The important implication for `ldk-cf` is this:

If we want to provide the same buyer-facing checkout pages, we need more than a page component. We also need to support the same checkout lifecycle on the worker side, especially `UNCONFIRMED -> CONFIRMED -> PENDING_PAYMENT`, product checkouts, customer collection, and signed URL redirects.

## What `@moneydevkit/nextjs` Ships

Published tarball contents are very small:

- `dist/components/Checkout.js`
- `dist/hooks/useCheckout.js`
- `dist/hooks/useCheckoutSuccess.js`
- `dist/hooks/useCustomer.js`
- `dist/hooks/useProducts.js`
- `dist/server/index.js`
- `dist/server/route.js`
- `dist/next-plugin.js`
- `dist/mdk-styles.css`

The package exports:

- client APIs from the root package
- server helpers from `@moneydevkit/nextjs/server`
- unified route from `@moneydevkit/nextjs/server/route`
- a Next.js bundler plugin from `@moneydevkit/nextjs/next-plugin`

In source, the Next.js package is almost entirely re-exports:

- `packages/nextjs/src/components/Checkout.tsx` re-exports `@moneydevkit/core/client`
- hooks re-export `@moneydevkit/core/client`
- `packages/nextjs/src/server/route.ts` re-exports `@moneydevkit/core/route`
- `packages/nextjs/src/server/index.ts` re-exports `createCheckoutUrl` and `withPayment`

The only truly Next-specific logic is the webpack tracing and externals handling for `@moneydevkit/lightning-js`.

## Where the Real Checkout Page Lives

The real implementation is in `packages/core`.

Relevant files:

- `packages/core/src/components/Checkout.tsx`
- `packages/core/src/components/checkout/*`
- `packages/core/src/hooks/*`
- `packages/core/src/client-actions.ts`
- `packages/core/src/actions.ts`
- `packages/core/src/route.ts`
- `packages/core/src/handlers/checkout.ts`
- `packages/core/src/mdk-styles.css`

### Buyer Flow in Upstream

1. Client calls `useCheckout().createCheckout(params)`.
2. Client POSTs to `/api/mdk` with `{ handler: 'create_checkout', params }`.
3. Server route validates input and calls `createCheckout()`.
4. `createCheckout()` calls MDK backend `checkout.create(...)`.
5. If MDK returns `CONFIRMED`, server generates a Lightning invoice locally and calls `checkout.registerInvoice(...)`.
6. Client navigates to `/checkout/:id`.
7. `<Checkout id={id} />` polls `/api/mdk` with `get_checkout`.
8. UI renders one of:
   - `UNCONFIRMED`
   - `CONFIRMED`
   - `PENDING_PAYMENT`
   - `PAYMENT_RECEIVED`
   - `EXPIRED`
9. On success it redirects to `successUrl` with a `checkoutId` query param.

### UI States Implemented Upstream

`Checkout.tsx` switches between four subviews plus a loading state:

- `UnconfirmedCheckout`
  - collects required customer fields
  - handles product selection state
  - handles custom amount entry
  - calls `confirm_checkout`
- `PendingPaymentCheckout`
  - shows QR code
  - shows invoice details and countdown
  - polls every second while pending
- `PaymentReceivedCheckout`
  - shows success state
  - continues to `successUrl`
- `ExpiredCheckout`
  - supports restart by creating a fresh checkout

## Unified Route Surface Expected by the UI

`@moneydevkit/core/route` exposes a single `/api/mdk` style endpoint.

POST handlers:

- `create_checkout`
- `get_checkout`
- `confirm_checkout`
- `list_products`
- `get_customer`
- plus non-checkout handlers like `webhook`, `payout`, `balance`, `ping`, `list_channels`, `sync_rgs`

GET handlers:

- `action=createCheckout`
  - verifies HMAC signature
  - creates checkout
  - redirects to `/checkout/:id`
- `action=renewSubscription`

Security behavior:

- secret auth for server-to-server routes
- CSRF cookie/header for browser routes
- webhook secret override allowed for server-to-server checkout calls
- signed checkout URLs use HMAC-SHA256 over sorted query params

## Current `ldk-cf` State

Current worker example and package support:

- create checkout
- poll checkout
- webhook handling
- balance, channel info, debug
- payout/pay helpers
- simple example dashboard

Current gaps versus upstream checkout pages:

- no built-in `/checkout/:id` page
- no `confirm_checkout`
- no `list_products` route exposed from worker HTTP layer
- no `get_customer`
- no signed `GET /api/mdk?action=createCheckout...` redirect flow
- no CSRF-protected unified `/api/mdk` browser route
- no worker-hosted success page helper
- checkout types are much narrower than upstream

## Most Important Compatibility Gap

The current `ldk-cf` checkout path assumes checkout creation always immediately yields a fixed invoice amount.

That is not true upstream.

In upstream:

- `createCheckout()` may return `UNCONFIRMED`
- invoice generation may happen later in `confirmCheckout()`
- product flows may need customer input first
- custom-price products may need the buyer to enter the amount first

In current `ldk-cf`, `LightningNode.createCheckout()` throws if `invoiceAmountSats` is missing:

- it requires `checkout.invoiceAmountSats`
- it immediately generates and registers an invoice

That means the current implementation cannot support the full checkout page experience yet.

This is the main architectural point. Rendering the page alone is insufficient.

## Type Mismatch

Current `ldk-cf` defines a simplified `Checkout` type:

- `status: 'pending' | 'completed' | 'expired' | string`
- optional `invoice`, `paymentHash`, `paymentUrl`, `invoiceScid`, `invoiceAmountSats`

Upstream uses a much richer contract from `@moneydevkit/api-contract`:

- statuses:
  - `UNCONFIRMED`
  - `CONFIRMED`
  - `PENDING_PAYMENT`
  - `PAYMENT_RECEIVED`
  - `EXPIRED`
- fields for:
  - products
  - customer data
  - selected product
  - custom amount
  - fiat totals
  - invoice payload with `amountSats`, `fiatAmount`, `btcPrice`, `amountSatsReceived`
  - success URL and user metadata

If we want upstream-compatible checkout pages, we should stop treating checkout as a tiny worker-local shape and instead model the upstream contract.

## What Can Be Reused

Directly reusable ideas:

- unified `/api/mdk` route shape
- signed checkout URL flow
- status model
- buyer-facing page states
- hook semantics

Potentially portable code:

- `packages/core/src/components/Checkout.tsx`
- `packages/core/src/components/checkout/*`
- `packages/core/src/hooks/*`
- `packages/core/src/providers.tsx`
- `packages/core/src/checkout-utils.ts`
- `packages/core/src/mdk-styles.css`

Not directly reusable in Workers:

- `packages/core/src/actions.ts`
- `packages/core/src/mdk.ts`
- `packages/core/src/lightning-node.ts`
- `packages/nextjs/src/next-plugin.ts`

Reason:

- Node-native `@moneydevkit/lightning-js`
- `process.env`
- Node `crypto`
- `Buffer`
- Next bundling assumptions

## Recommended Implementation Direction

### Recommendation

Do not try to make `@moneydevkit/nextjs` run inside Cloudflare Workers.

Instead:

1. Make `ldk-cf` expose an upstream-compatible checkout backend surface.
2. Port or extract the upstream client-side checkout UI into a worker-friendly hosted page package.

### Backend Work Needed First

Add a worker-side compatibility layer that mirrors upstream route behavior:

- `create_checkout`
- `get_checkout`
- `confirm_checkout`
- `list_products`
- `get_customer`
- GET signed checkout creation redirect

Add or expand worker methods roughly like:

- `startCheckout(params)`
  - call MDK `checkout.create`
  - if already `CONFIRMED`, generate/register invoice
  - if `UNCONFIRMED`, return raw checkout untouched
- `confirmCheckout(confirm)`
  - call MDK `checkout.confirm`
  - generate/register invoice
  - return enriched checkout

Also expand the worker MDK client to cover:

- `checkouts.confirm`
- `customers.get`

### UI Packaging Options

#### Option A: Framework-agnostic checkout page bundle

Ship a built-in static checkout page from this package:

- `GET /checkout/:id` returns HTML
- client JS calls `/api/mdk`
- worker users get checkout pages with no React setup

This best matches "people can use it with their worker".

#### Option B: React package plus example worker routes

Extract the portable upstream UI into a new package, for example:

- `@moneydevkit/checkout-ui`

Then:

- `@moneydevkit/nextjs` consumes it
- `ldk-cf` consumes it for worker-hosted pages or framework examples

This is cleaner long term, but slower if the immediate goal is turnkey worker checkout pages.

### Recommended Sequence

1. Normalize `ldk-cf` checkout types to the upstream API contract.
2. Add `confirm_checkout`, `list_products`, and `get_customer`.
3. Add unified `/api/mdk` browser route behavior with CSRF and signed GET redirects.
4. Port checkout page UI states.
5. Add a worker example exposing `/checkout/:id` and success handling.

## Practical Product Decision

If the goal is parity with the buyer experience of `@moneydevkit/nextjs`, the package should probably expose a higher-level router helper instead of only low-level DO methods.

Something in this direction:

```ts
import { LightningNode, createCheckoutRouter } from 'mdk-cloudflare'

export { LightningNode }

export default {
  fetch(request, env) {
    return createCheckoutRouter({
      request,
      env,
      nodeNamespace: env.LIGHTNING_NODE,
      checkoutBasePath: '/checkout',
      apiPath: '/api/mdk',
      includeCheckoutPages: true,
    })
  },
}
```

That would let worker users opt into:

- webhook route
- unified checkout API route
- checkout pages
- success redirect support

without rebuilding the flow manually.

## Bottom Line

Yes, `ldk-cf` can provide the same checkout pages or built-in checkout pages, but only if we treat this as a full checkout-compatibility project, not a page-porting task.

The critical missing piece is not the UI. It is the upstream checkout lifecycle:

- richer checkout types
- unconfirmed-to-confirmed transition
- product and customer flows
- unified `/api/mdk` route semantics

Once that backend surface exists, the upstream checkout page behavior is portable.
