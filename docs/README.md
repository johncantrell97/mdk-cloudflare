# Internal Development Docs

These are design documents from the development of mdk-cloudflare.
They are kept for historical reference and to help contributors understand architectural decisions.

For user-facing documentation, see:

- the repo [README](../README.md)
- the architecture guide in [ARCHITECTURE.md](../ARCHITECTURE.md)
- the checkout page setup guide in [CHECKOUT_PAGE_SETUP.md](../CHECKOUT_PAGE_SETUP.md)
- the agent guide in [llms.txt](../llms.txt)

## Architecture & Design

| Document | Status | Description |
|---|---|---|
| `2026-03-10-ldk-cf.md` | Implemented | Original architecture plan for LDK-on-WASM |
| `2026-03-10-ldk-cf-design.md` | Implemented | Detailed design decisions (trait impls, sync/async bridge) |
| `2026-03-11-example-worker-design.md` | Implemented | Example worker design |
| `2026-03-15-moneydevkit-nextjs-checkout-exploration.md` | Research | Deep exploration of `@moneydevkit/nextjs` checkout and worker parity requirements |
