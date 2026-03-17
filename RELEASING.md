# Releasing

## Public Packages

The public release surface is:

- `mdk-cloudflare`

`ldk-wasm` is bundled into `mdk-cloudflare` and is not published separately.

## Version Updates

Keep these versions aligned before a release:

- `packages/lightning-cloudflare/package.json`
- `packages/lightning-cloudflare/package.json` dependency on `ldk-wasm`
- `crates/ldk-wasm/Cargo.toml`
- `packages/ldk-wasm/package.json`
- `CHANGELOG.md`

## Verification

Run the full release checks from the repo root:

```bash
pnpm install
pnpm build
pnpm test:ts
pnpm test:wasm
pnpm pack:check
pnpm --dir examples/react-vite-worker build
pnpm --dir examples/react-router-worker build
```

Optional but recommended before a release announcement:

- `cd packages/lightning-cloudflare && npm publish --dry-run`
- run one deployed MDK checkout smoke test against a real Worker URL

`pnpm pack:check` verifies the actual npm tarballs contain:

- the built `dist/` output
- package README and license files
- the bundled `ldk-wasm` dependency for `mdk-cloudflare`
- the bundled WASM binary
- a publishable dependency version, not a workspace reference

## Publishing

Publish from the backend package directory using `npm publish`.

```bash
cd packages/lightning-cloudflare
npm publish
```

Do not use `pnpm pack` or `pnpm publish` for the final `mdk-cloudflare` artifact. That package uses
`bundleDependencies`, and `pnpm` with `nodeLinker: isolated` does not produce the correct packed output there.
