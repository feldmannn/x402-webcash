# x402-webcash

An [x402](https://github.com/coinbase/x402) payment scheme for [webcash](https://webcash.org) — bearer-token e-cash settled by an atomic-replacement issuer.

This repo contains:

- **[`specs/scheme_webcash.md`](specs/scheme_webcash.md)** — the formal scheme specification, written against the x402 v2 scheme template. Intended to be proposed upstream to `coinbase/x402`.
- **`src/`** — a TypeScript reference facilitator implementing `POST /verify`, `POST /settle`, and `GET /supported` for the `webcash` scheme.
- **`examples/express-server.ts`** — a tiny Express resource server that paywalls an endpoint using this facilitator.

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

## License

MIT
