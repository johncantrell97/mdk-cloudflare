# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Note

- Historical changelog entries before `0.1.2` reference `mdk-cloudflare-react`. The current repo no longer ships that package; use `@moneydevkit/core` for the React checkout page UI.

## [0.1.3] - 2026-03-17

### Fixed

- Secret-authenticated `/api/mdk` routes such as `webhooks` and `ping` now forward an unconsumed request body into the Durable Object, which fixes live Worker crashes during MDK payment-claim callbacks.
- The React examples and standalone smoke app now treat a settled invoice as paid even before the checkout status flips to `PAYMENT_RECEIVED`.
- The React examples and standalone smoke app now auto-redirect from the official MDK checkout screen to `/success` after payment instead of waiting for a manual "Continue" click.

## [0.1.2] - 2026-03-17

### Fixed

- `mdk-cloudflare` now sends the upstream-correct `{ id }` payload to `checkout/get`, which fixes checkout pages failing with `Input validation failed` after a successful `create_checkout`.
- The internal `/api/mdk` route now consistently uses `MDK_ACCESS_TOKEN` for secret-authenticated MDK server traffic.
- Repo examples, setup docs, and agent instructions no longer tell users to configure `MDK_WEBHOOK_SECRET` for the built-in `/api/mdk` route.

## [0.1.1] - 2026-03-16

### Fixed

- External Worker TypeScript installs no longer require resolving `cloudflare:workers` from the published `mdk-cloudflare` declaration files.
- `mdk-cloudflare-react` now consumes `mdk-cloudflare/types` so browser and React apps do not pull the Worker Durable Object surface into their TypeScript config.
- The basic Worker example now typechecks with a Worker-safe `tsconfig` and is covered in CI.
- Release verification now includes a packaged-install smoke test for clean Worker and React consumers.
- WASM package preparation now normalizes the generated `ldk-wasm` manifest for repeatable `npm pack` and publish verification.

## [0.1.0] - 2026-03-15

Initial public release.

### Added

- `mdk-cloudflare`: Durable Object backend for Cloudflare Workers with checkout, payment, and node APIs.
- `mdk-cloudflare-react`: React checkout page UI for apps that want drop-in buyer pages on top of `/api/mdk`.
- `ldk-wasm`: bundled LDK-on-WASM runtime used internally by `mdk-cloudflare`.
- Unified `/api/mdk` route support including `create_checkout`, `get_checkout`, `confirm_checkout`, `list_products`, `get_customer`, signed create-checkout URLs, CSRF handling, and webhook forwarding.
- Checkout flows for amount and product purchases with polling through confirmation and payment completion.
- Outbound BOLT11 payments with RGS-based pathfinding.
- Inbound payment claiming via webhook processing and LSPS4 JIT channels.
- `getNodeId()`, `getNodeInfo()`, and `debug()` for node introspection.
- LNURL utilities: `resolveDestinationToInvoice()` and `parseBolt11AmountMsat()`.
- DO SQLite-backed storage, crash recovery, and periodic sync/rebroadcast alarms.
- Example apps in `examples/basic-worker/`, `examples/react-vite-worker/`, and `examples/react-router-worker/`.
- Checkout page setup guide in `CHECKOUT_PAGE_SETUP.md`.
- Agent-oriented integration guidance in `llms.txt`.
