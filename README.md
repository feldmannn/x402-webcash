# x402-webcash

An [x402](https://github.com/coinbase/x402) payment scheme for [webcash](https://webcash.org) — bearer-token e-cash settled by an atomic-replacement issuer.

This repo contains:

- **[`specs/scheme_webcash.md`](specs/scheme_webcash.md)** — the formal scheme specification, written against the x402 v2 scheme template. Intended to be proposed upstream to `coinbase/x402`.
- **`src/`** — a TypeScript reference facilitator implementing `POST /verify`, `POST /settle`, and `GET /supported` for the `webcash` scheme, plus an Express middleware and a client-side scheme handler.
- **`src/client/`** — a transport-agnostic client (also exported as `x402-webcash/client`): `FileWallet`, `buildWebcashHeader`, and a `wrapFetchWithWebcash` fetch adapter that auto-settles 402s.
- **`examples/express-server.ts`** — a tiny Express resource server that paywalls an endpoint using this facilitator.
- **`examples/fetch-client.ts`** — a client that spends a webcash secret to call the paywalled endpoint above.
- **`examples/mcp-server.ts`** — a stdio MCP server that exposes the paywalled endpoint as an MCP tool; Claude Desktop (or any MCP client) can call it and the server settles in webcash transparently.

## Why

x402 is the emerging standard for HTTP-native, agent-friendly payments. Today its only scheme is `exact` (EIP-3009 stablecoin transfers). Webcash is a different shape — bearer secrets, issuer-enforced replay prevention, no signatures — but the x402 framing (`scheme` + `network` + `payload` + facilitator `verify`/`settle`) accommodates it cleanly.

Adding `webcash` as an x402 scheme means any x402-aware client gains the ability to pay in webcash, and any service already accepting webcash (e.g., [harmoniis](https://harmoniis.com)) becomes reachable to the broader x402 ecosystem with a thin adapter.

## Status

Early. Spec is v0 and unproposed. Facilitator is reference-quality, not production. Issuer URL allowlisting and TLS-pinning are open items. See `specs/scheme_webcash.md` for the gaps.

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

### Wiring into an MCP server

`examples/mcp-server.ts` is a runnable stdio MCP server that exposes
the paywalled `/premium` endpoint as a tool. The MCP SDK is a
devDependency of this repo (consumers of `x402-webcash` who don't want
MCP do not need to install it).

Three-terminal demo:

```bash
npm run facilitator     # :4021
npm run example         # :4020 (paywalled /premium)
npm run example:mcp     # stdio MCP server
```

Then add the MCP server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-webcash-demo": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/examples/mcp-server.ts"],
      "env": { "WEBCASH_WALLET": "/absolute/path/to/client-wallet.json" }
    }
  }
}
```

Calling the `get-premium-data` tool triggers a 402 from the resource
server; the wrapped fetch takes a webcash secret from the wallet
(auto-splitting a larger one if needed), retries with X-PAYMENT, and
returns the 200 body to the agent. See `examples/mcp-server.ts` for the
~30 lines of glue.

## License

MIT
