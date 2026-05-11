# x402-webcash

An [x402](https://github.com/coinbase/x402) payment scheme for [webcash](https://webcash.org) — bearer-token e-cash settled by an atomic-replacement issuer.

This repo contains:

- **[`specs/scheme_webcash.md`](specs/scheme_webcash.md)** — the formal scheme specification, written against the x402 v2 scheme template. Intended to be proposed upstream to `coinbase/x402`.
- **`src/`** — a TypeScript reference facilitator implementing `POST /verify`, `POST /settle`, and `GET /supported` for the `webcash` scheme, plus an Express middleware and a client-side scheme handler.
- **`src/client/`** — a transport-agnostic client (also exported as `x402-webcash/client`): `FileWallet`, `buildWebcashHeader`, and a `wrapFetchWithWebcash` fetch adapter that auto-settles 402s.
- **`examples/express-server.ts`** — a tiny Express resource server that paywalls an endpoint using this facilitator.
- **`examples/fetch-client.ts`** — a client that spends a webcash secret to call the paywalled endpoint above.

For exposing webcash payments to AI agents over MCP, see the separate **[`webcash-mcp`](https://github.com/feldmannn/webcash-mcp)** project — a general-purpose MCP server that wraps this library.

## Why

x402 is the emerging standard for HTTP-native, agent-friendly payments. Today its only scheme is `exact` (EIP-3009 stablecoin transfers). Webcash is a different shape — bearer secrets, issuer-enforced replay prevention, no signatures — but the x402 framing (`scheme` + `network` + `payload` + facilitator `verify`/`settle`) accommodates it cleanly.

Adding `webcash` as an x402 scheme means any x402-aware client gains the ability to pay in webcash, and any service already accepting webcash (e.g., [harmoniis](https://harmoniis.com)) becomes reachable to the broader x402 ecosystem with a thin adapter.

## Status

Early. Spec is v0 and unproposed.

What's in place as of 0.4.0:

- **Issuer URL allowlist:** `FacilitatorOptions.issuerAllowlist` (or `WEBCASH_ISSUER_ALLOWLIST=url1,url2` env var). Canonical webcash.org issuers are always included. Any `extra.issuerUrl` outside the allowlist is rejected at verify with `invalid_network`.
- **HTTPS enforcement:** facilitator, paywall middleware, and the client-side splitter all reject non-HTTPS issuer/facilitator URLs that are not loopback. Opt-out (`allowHttpIssuer` / `allowHttpFacilitator` / `WEBCASH_ALLOW_HTTP_ISSUER=1`) is reserved for test rigs.
- **Concurrency-safe FileWallet:** in-process mutex serializes wallet operations so concurrent `takeExact` calls cannot double-spend or clobber writes. Not safe across processes — use SQLite/keychain-backed wallets for multi-process deployments.
- **Pre-flight journal hook:** `wrapFetchWithWebcash` accepts a `journal` callback that fires after a secret is taken from the wallet but before the request is sent, so a process crash mid-request can be reconciled.
- **Full failure-mode coverage** for: settlement integrity (server-side), ambiguous response (client-side), split rejection vs split ambiguity, persistence-failure recovery hooks, and `[x402-webcash][CRITICAL]` stderr breadcrumbs on every fund-loss path.

Still open / future work:

- TLS certificate / SPKI pinning beyond simple HTTPS enforcement (requires custom dispatcher; out of scope for v0.x).
- `extra.recipientPublicHash` is reserved in the spec but the underlying mechanism for binding an output secret to a recipient hash needs more design — without a protocol-level binding, the facilitator can substitute its own output. The practical mitigation today is "the facilitator is part of your trusted set" or "self-host the facilitator inside your resource server."
- No security audit by a third party. Production deployments should review the codebase themselves until that lands.

See `specs/scheme_webcash.md` for the spec-level discussion of these.

## Quick start

```bash
npm install
npm run build
npm run facilitator   # starts the facilitator on :4021
npm run example       # starts the paywalled Express server on :4020
```

Then from a client:

```bash
# Probe (no payment) — should return 402 with PaymentRequired body
curl -i http://localhost:4020/premium

# Retry with a webcash secret in X-PAYMENT (base64-encoded PaymentPayload)
curl -i -H "X-PAYMENT: $PAYLOAD_B64" http://localhost:4020/premium
```

Or via the TypeScript client (handles the 402 + retry automatically):

```bash
echo '{"secrets":["e0.3:secret:<your-hex>"]}' > ./client-wallet.json
npm run example:client
```

## Using the client in your own code

```typescript
import { FileWallet, wrapFetchWithWebcash } from "x402-webcash/client";

const wallet = new FileWallet("./wallet.json");
const pay = wrapFetchWithWebcash(fetch, { wallet });

const res = await pay("https://api.example.com/premium");
// On 402 advertising webcash, `pay` takes a matching secret from the wallet,
// retries with X-PAYMENT, and returns the 200. Schemes other than webcash
// pass through unchanged so you can chain other handlers.
```

For non-fetch transports (axios, undici Dispatcher, MCP transports), call
`buildWebcashHeader(body, wallet)` directly — it returns the base64 header
string for the X-PAYMENT field plus the secret you took, so you can wire the
retry into whatever client you already have.

### Auto-split

By default, the wallet must hold an unspent secret of *exactly* the amount
the resource server demands. Pass `autoSplit` to derive an exact-amount
secret on demand by asking the issuer to atomically replace a larger one
with `[required, change]`:

```typescript
const pay = wrapFetchWithWebcash(fetch, { wallet, autoSplit: {} });
```

The issuer URL is read from the 402 challenge itself (`extra.issuerUrl` or
`payTo`). On clean rejection the input secret is returned to the wallet;
on a network failure the outcome is ambiguous, the input is NOT returned
(it may have been spent at the issuer), and both newly-minted output
secrets are logged to stderr with the `[x402-webcash][CRITICAL]` marker
so an operator can recover them. See `splitToMatch` for the full
failure-mode contract.

### Using with AI agents (MCP)

If you want AI agents to be able to pay webcash-protected URLs over MCP,
use [**webcash-mcp**](https://github.com/feldmannn/webcash-mcp) — a
general-purpose stdio MCP server built on top of this library. It exposes
`pay_fetch`, `wallet_balance`, `wallet_import`, and `wallet_status` tools
that any MCP client (Claude Desktop, etc.) can call.

## License

MIT
