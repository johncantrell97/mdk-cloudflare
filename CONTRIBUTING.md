# Contributing to mdk-cloudflare

Thanks for your interest in contributing! This document covers the basics.

## Development Setup

```bash
# Prerequisites: Rust, wasm-pack, Node.js >= 18, pnpm
git clone https://github.com/johncantrell97/mdk-cloudflare.git
cd mdk-cloudflare
pnpm install
pnpm build
```

## Building

```bash
pnpm build          # Full build (WASM + TypeScript)
pnpm build:wasm     # Rust WASM crate only
pnpm build:packages # TypeScript packages only
pnpm check          # Quick Rust compile check (no WASM output)
pnpm pack:check     # Verify the packed npm artifact
```

## Testing

```bash
pnpm test:ts
pnpm test:wasm
```

## Project Structure

```
mdk-cloudflare/
├── crates/ldk-wasm/   # Rust WASM crate (LDK wrapper)
├── packages/
│   ├── ldk-wasm/      # Generated workspace package bundled into npm releases
│   └── lightning-cloudflare/ # TypeScript package (Durable Object + orchestration)
├── examples/
│   ├── basic-worker/       # Low-level example Cloudflare Worker
│   ├── react-vite-worker/  # Checkout page example using React + Vite
│   └── react-router-worker/ # Checkout page example using React Router
├── docs/                   # Internal architecture and design docs
└── scripts/                # Build scripts
```

## Code Style

- **Rust**: `cargo fmt` for formatting. The default target is `wasm32-unknown-unknown`.
- **TypeScript**: Strict mode enabled. No additional linting configured.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `pnpm build` and tests pass
4. Submit a PR with a clear description of what and why

For maintainers preparing a release, see [`RELEASING.md`](RELEASING.md).

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (Node.js version, Cloudflare Workers plan, etc.)

For security issues, follow [`SECURITY.md`](SECURITY.md) instead of filing a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT OR Apache-2.0 license.
