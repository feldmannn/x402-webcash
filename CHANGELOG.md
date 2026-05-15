# Changelog

All notable changes to `x402-webcash`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semver but is still pre-1.0, so minor versions may include breaking changes until the spec is proposed upstream.

## [0.5.3] — 2026-05-15

### Changed

- Documentation update. README now covers the `webcashSettler` + `@feldmannn/x402-mcp` integration with a worked example (verified against the published `0.1.0` `.d.ts`), mentions `webcash-mcp`'s `pay_tool`, and adds CI + npm badges. First release with a `CHANGELOG.md` (shipped to npm via the `files` array).
- `build` script now cleans `dist/` first, so stale artifacts from earlier builds no longer bloat the npm tarball. The published 0.5.3 tarball is **53 files / 45 kB** (down from 137 / 75 kB in 0.5.1).

### Notes

- `v0.5.2` exists as a git tag but was never published to npm — the same doc improvements ship in 0.5.3 along with the build cleanup.

## [0.5.2] — git-only, never published to npm

- Tag exists on GitHub but the build still included stale `dist/tests/*` and `dist/examples/*` from a pre-`tsconfig.build.json` layout. Superseded by 0.5.3, which carries the same documentation plus a `prebuild clean` step. Do not depend on this version.

## [0.5.1] — 2026-05-13

### Added

- **`webcashSettler(facilitator)`** — adapter that wraps a `Facilitator` into the `Settler` interface expected by [`@feldmannn/x402-mcp`](https://github.com/feldmannn/x402-mcp). Enforces the same integrity gates as the Express middleware (output-secret presence, parseability, and amount agreement with requirements). Mint failures map to `retriable: true`; all other failures to `retriable: false`.
- **`decimalToWats(s)`** — converts a decimal webcash string (e.g. `"0.001"`) to wats as a `bigint`. Symmetric with the existing `watsToDecimal`.

## [0.5.0] — 2026-05-12

### Added

- First npm publish. Package metadata (author, repository, keywords, `files` field) and `prepare` script.
- GitHub Actions CI: build + test on Node 20 and 22.

### Changed

- Build emits to `dist/index.js` (matching the path advertised by `package.json` `exports`).
- `FileWallet` strips a UTF-8 BOM when reading the wallet file, so wallets created by Windows editors round-trip cleanly.

### Removed

- `examples/mcp-server.ts` moved to the standalone [`webcash-mcp`](https://github.com/feldmannn/webcash-mcp) repo. The `example:mcp` script is gone.

## [0.4.0] — pre-npm

### Added (hardening)

- **In-process FileWallet mutex** — serializes wallet operations so concurrent `takeExact` calls cannot double-spend or clobber writes. Not cross-process safe; use a SQLite/keychain-backed wallet for multi-process deployments.
- **HTTPS enforcement** — facilitator, paywall middleware, and the client-side splitter reject non-HTTPS issuer/facilitator URLs that are not loopback. Opt-out via `allowHttpIssuer` / `allowHttpFacilitator` / `WEBCASH_ALLOW_HTTP_ISSUER=1` for test rigs only.
- **Pre-flight journal hook** — `wrapFetchWithWebcash` accepts a `journal` callback that fires after the secret is taken from the wallet but before the request is sent, so a process crash mid-request can be reconciled.
- **Output-amount integrity gate** in `webcashSettler` and middleware: a settled output whose embedded amount does not match the buyer's requirements is rejected with a `[x402-webcash][CRITICAL]` stderr breadcrumb.

## [0.3.x and earlier] — pre-npm

### Added

- **Client-side scheme handler** — `FileWallet`, `MemoryWallet`, `buildWebcashHeader`, `wrapFetchWithWebcash`. Transport-agnostic; also exported via the `x402-webcash/client` subpath.
- **Auto-split** — `splitToMatch` derives an exact-amount secret from a larger one by asking the issuer to atomically replace it with `[required, change]`. Documented failure modes for clean rejection vs. ambiguous network failure.
- **Round 2 review fixes** — persistence-recovery hook, mint crash handling, network/`accepted` echo gaps.
- **Round 3 review fixes** — settlement integrity gate, fetch timeouts, defensive issuer URL parsing.
- **Initial release** — x402 v2 scheme spec (`specs/scheme_webcash.md`), `Facilitator` with `/verify` `/settle` `/supported`, Express `paywall` middleware.

[0.5.3]: https://github.com/feldmannn/x402-webcash/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/feldmannn/x402-webcash/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/feldmannn/x402-webcash/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/feldmannn/x402-webcash/releases/tag/v0.5.0
