# x402-webcash

[![ci](https://github.com/feldmannn/x402-webcash/actions/workflows/ci.yml/badge.svg)](https://github.com/feldmannn/x402-webcash/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/x402-webcash.svg)](https://www.npmjs.com/package/x402-webcash)

An [x402](https://github.com/coinbase/x402) payment scheme for [webcash](https://webcash.org) — bearer-token e-cash settled by an atomic-replacement issuer.

This repo contains:

- **[`specs/scheme_webcash.md`](specs/scheme_webcash.md)** — the formal scheme specification, written against the x402 v2 scheme template. Intended to be proposed upstream to `coinbase/x402`.
- **`src/`** — a TypeScript reference facilitator implementing `POST /verify`, `POST /settle`, and `GET /supported` for the `webcash` scheme, plus an Express middleware and a client-side scheme handler.
- **`src/client/`** — a transport-agnostic client (also exported as `x402-webcash/client`): `FileWallet`, `buildWebcashHeader`, and a `wrapFetchWithWebcash` fetch adapter that auto-settles 402s.
- **`src/mcp-settler.ts`** — `webcashSettler(facilitator)`, an adapter that plugs this library's `Facilitator` into [`@feldmannn/x402-mcp`](https://github.com/feldmannn/x402-mcp) so MCP tools can be paywalled in webcash.
- **`examples/express-server.ts`** — a tiny Express resource server that paywalls an endpoint using this facilitator.
- **`examples/fetch-client.ts`** — a client that spends a webcash secret to call the paywalled endpoint above.

For exposing webcash payments to AI agents over MCP, see the separate **[`webcash-mcp`](https://github.com/feldmannn/webcash-mcp)** project — a general-purpose MCP server that wraps this library.

## Why

x402 is the emerging standard for HTTP-native, agent-friendly payments. Today its only scheme is `exact` (EIP-3009 stablecoin transfers). Webcash is a different shape — bearer secrets, issuer-enforced replay prevention, no signatures — but the x402 framing (`scheme` + `network` + `payload` + facilitator `verify`/`settle`) accommodates it cleanly.

Adding `webcash` as an x402 scheme means any x402-aware client gains the ability to pay in webcash, and any service already accepting webcash (e.g., [harmoniis](https://harmoniis.com)) becomes reachable to the broader x402 ecosystem with a thin adapter.

## Status

**1.0** — feature-complete reference implementation, spec ready for upstream proposal to `coinbase/x402`. 122 tests covering every documented failure mode.

What's in 1.0:

- **Facilitator + Express paywall + transport-agnostic client.** `Facilitator.verify` / `Facilitator.settle` / `GET /supported` for x402 v2; Express `paywall` middleware; `FileWallet` + `buildWebcashHeader` + `wrapFetchWithWebcash` on the client side.
- **`paywallLocal(facilitator, opts)`** — in-process facilitator paywall. No HTTP hop, no third-party trust boundary; combined with a caller-supplied `mintOutputSecret`, the resource server controls every step of settlement.
- **SPKI certificate pinning.** `pinnedSpkiHashes` is accepted on `Facilitator`, `paywall`, `splitToMatch`, and `wrapFetchWithWebcash`'s `autoSplit`. Pinning is additive (default CA + hostname validation runs first); a mismatch fails at TLS handshake before any bearer secret is transmitted. RFC 7469 pin format. `createPinnedFetch({ pinnedSpkiHashes })` is exported for callers using custom transports.
- **Recipient binding (buyer-derived outputs).** The 402 challenge can advertise an X25519 public key + nonce; the buyer derives the output secret via ECDH+HKDF; the facilitator is contractually constrained to use exactly that secret in `/replace`; the resource server verifies the returned secret against its private key post-settlement. Closes the facilitator-substitution attack on remote facilitator deployments. See `specs/scheme_webcash.md` "Recipient binding".
- **Issuer URL allowlist.** `FacilitatorOptions.issuerAllowlist` (or `WEBCASH_ISSUER_ALLOWLIST=url1,url2`). Canonical webcash.org issuers are always included; `extra.issuerUrl` outside the allowlist is rejected at verify with `invalid_network`.
- **HTTPS enforcement.** Facilitator, paywall middleware, and the client-side splitter all reject non-HTTPS URLs that are not loopback. Opt-out (`allowHttpIssuer` / `allowHttpFacilitator` / `WEBCASH_ALLOW_HTTP_ISSUER=1`) is reserved for test rigs.
- **Concurrency-safe FileWallet.** In-process mutex serializes wallet operations so concurrent `takeExact` calls cannot double-spend or clobber writes. Not safe across processes — use SQLite/keychain-backed wallets for multi-process deployments.
- **Pre-flight journal hook.** `wrapFetchWithWebcash` accepts a `journal` callback that fires after a secret is taken from the wallet but before the request is sent, so a process crash mid-request can be reconciled.
- **Full failure-mode coverage** for: settlement integrity (server-side), ambiguous response (client-side), split rejection vs split ambiguity, persistence-failure recovery hooks, binding-substitution detection, and `[x402-webcash][CRITICAL]` stderr breadcrumbs on every fund-loss path.
- **MCP bridge.** `webcashSettler(facilitator)` adapts the facilitator to [`@feldmannn/x402-mcp`](https://github.com/feldmannn/x402-mcp)'s `Settler` interface.

See `specs/scheme_webcash.md` for the full protocol and security model, including the recipient-binding race-window analysis. See [`SECURITY.md`](SECURITY.md) for the trust model and how to report vulnerabilities.

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

### Paywalling MCP tools (`webcashSettler`)

To accept webcash for your own MCP tools, pair this library's facilitator
with [`@feldmannn/x402-mcp`](https://github.com/feldmannn/x402-mcp):

```typescript
import { Facilitator, webcashSettler, decimalToWats, type WebcashOutput } from "x402-webcash";
import { createPaywall } from "@feldmannn/x402-mcp";

const facilitator = new Facilitator({
  issuerAllowlist: ["https://webcash.org"],
});

const paywall = createPaywall<WebcashOutput>({
  settler: webcashSettler(facilitator),
  scheme: "webcash",
  asset: "webcash",
  network: "webcash:mainnet",
  payTo: "https://webcash.org",
  onSettled: async (output) => {
    // Persist `output.secret` to your wallet — or you lose the funds.
  },
});

// Then wrap any MCP tool handler:
server.registerTool("premium_search", schema, paywall.gate(
  {
    amount: decimalToWats("0.001").toString(), // 0.001 webcash in wats (x402 v2 is string)
    resourceUrl: "mcp://your-server/premium_search",
  },
  async (args, extra) => {
    return { content: [{ type: "text", text: "result" }] };
  },
));
```

`webcashSettler` enforces the same integrity gates as the Express
middleware: success responses without a parseable output secret, or with
an output secret whose embedded amount disagrees with the buyer's
requirements, are converted into non-retriable failures and logged to
stderr with `[x402-webcash][CRITICAL]` so an operator can audit the
facilitator. Mint failures map to `retriable: true` (the input was never
sent to the issuer); all other failures map to `retriable: false`.

## Server-side deployment models

There are three ways to paywall a resource with this library, in order of increasing facilitator trust required:

### 1. In-process facilitator (strongest)

The resource server runs the facilitator itself. No third party is in the trust set. The resource server controls the output secret directly via `mintOutputSecret`.

```typescript
import { Facilitator, paywallLocal } from "x402-webcash";
import express from "express";

const facilitator = new Facilitator({
  issuerAllowlist: ["https://webcash.org"],
  mintOutputSecret: (amountDecimal) => myWallet.newSecret(amountDecimal),
});

const app = express();
app.get(
  "/premium",
  paywallLocal(facilitator, {
    amountWats: 30_000_000n,
    onSettled: (output) => myWallet.put(output.secret),
  }),
  (_req, res) => res.json({ ok: true }),
);
```

### 2. Remote facilitator with recipient binding (middle ground)

A separate facilitator service settles for you, but it cannot substitute its own output secret — the buyer derives one via ECDH against your X25519 public key, and you verify the returned secret against your private key. The facilitator briefly knows the secret (it has to, to call `/replace`); the residual risk is a race to spend in the gap between settlement and your refresh. Spend immediately in `onSettled` to minimize the window.

```typescript
import { paywall, RecipientKey } from "x402-webcash";

const recipientKey = RecipientKey.generate(); // or RecipientKey.fromJwk(persistedJwk)

app.get(
  "/premium",
  paywall({
    amountWats: 30_000_000n,
    facilitatorUrl: "https://facilitator.example.com",
    pinnedSpkiHashes: [/* current pin */, /* backup pin */],
    recipientKey,
    onSettled: async (output) => {
      // Refresh immediately to close the race window.
      await myWallet.refreshAndPut(output.secret);
    },
  }),
  (_req, res) => res.json({ ok: true }),
);
```

### 3. Remote facilitator without binding (trust the operator)

The classic deployment. The facilitator chooses the output secret; you trust it as part of your security perimeter. Useful when you have an operational relationship with the facilitator operator (e.g., self-hosted on the same VPC, or run by an org you trust).

```typescript
import { paywall } from "x402-webcash";

app.get(
  "/premium",
  paywall({
    amountWats: 30_000_000n,
    facilitatorUrl: "https://facilitator.example.com",
    pinnedSpkiHashes: [/* current pin */, /* backup pin */],
    onSettled: (output) => myWallet.put(output.secret),
  }),
  (_req, res) => res.json({ ok: true }),
);
```

## SPKI certificate pinning

Plain HTTPS trusts the public CA system. To defend against a CA-mis-issued cert on the facilitator↔issuer or paywall↔facilitator channel, configure SPKI pins on every HTTPS leg:

```typescript
new Facilitator({
  pinnedSpkiHashes: [
    "NWny299lvjd0rPs5z5gb8Vq5tyjlt6vn5C4N6MF4Ltg=", // current
    "AAAAAAAAbackupAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",  // backup
  ],
});
```

Compute the pin for an HTTPS endpoint:

```bash
openssl s_client -connect webcash.org:443 < /dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary | base64
```

Configure at least two pins (current + backup) so a planned key rotation is not an outage. Pinning is **additive** to default CA validation — it strengthens trust, never weakens it. A mismatch fails at TLS handshake with `PinMismatchError` before any bearer secret is transmitted.

## Operator security: the recovery log

This library writes `[x402-webcash][CRITICAL] …` lines to **stderr** on every fund-loss-adjacent code path. These are the deliberate last-resort witness: without them, a transient disk error during persistence, an ambiguous network failure mid-split, or a malformed facilitator response would silently destroy funds.

**Several of these lines contain webcash secrets in plaintext.** Anyone who reads the log line can spend them. Specifically:

- `middleware.ts` → `persistence_failure secret=…` and `recovery_callback_also_failed secret=…` when the seller's `onSettled`/`onSettledRecovery` hooks throw.
- `client/split.ts` → both `[required, change]` output secrets when an auto-split's network outcome is ambiguous.
- `client/fetch.ts` → wallet-restoration failures after a 402 retry path errors.

The `mcp-settler.ts` and integrity-gate paths log `transaction=…` and `amount` material only — not the secret itself — because the facilitator has already moved the funds by then.

Operator responsibilities:

- **Do NOT ship stderr from a webcash facilitator, paywalled server, or splitter-using client to third-party log aggregators** (Datadog, Loggly, Splunk Cloud, etc.) without redacting `secret=` and the full output-secret line. Treat that stream like a `.env` file.
- **Provide `onSettledRecovery` callbacks** that write to a sink independent of your primary persistence (encrypted file on disk, secrets manager). If the recovery callback also fails, the secret is still in stderr — but a healthy operator should never need to grep for it.
- **Search by `transaction=` first**, not `secret=`. The error responses returned to callers embed `transaction=<id>` so you can correlate the failed call with the recovery line without grepping for secret material in shared incident channels.

## Using with AI agents (MCP)

If you want AI agents to be able to pay webcash-protected URLs and MCP
tools, use [**webcash-mcp**](https://github.com/feldmannn/webcash-mcp) —
a general-purpose stdio MCP server built on top of this library. It
exposes `pay_fetch` (HTTP-402), `pay_tool` (MCP-402, via
`@feldmannn/x402-mcp`), `wallet_balance`, `wallet_import`, and
`wallet_status` tools that any MCP client (Claude Desktop, etc.) can
call.

## License

MIT
