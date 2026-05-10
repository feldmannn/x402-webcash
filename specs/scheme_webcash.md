# Scheme: `webcash`

**Status:** Draft v0 (not yet proposed upstream)
**x402 protocol version:** 2

## Summary

The `webcash` scheme transfers a specific amount of bearer-token webcash from a client to a resource server. Webcash is an experimental electronic cash system in which each token is a one-time-spendable secret of the form `e<amount>:secret:<hex>`, validated and replaced by a centralized issuer (canonically [webcash.org](https://webcash.org)).

Unlike the `exact` scheme — which uses chain-enforced replay prevention via EIP-3009 nonces and an EIP-712 signature — `webcash` relies on the issuer's atomic-replacement guarantee: a secret that has been replaced cannot be replaced again. **Possession of an unspent secret IS the authority to spend it; there is no separate signature.**

## Use Cases

- AI agents paying for HTTP API access with bearer e-cash
- Per-call micropayments at sub-cent denominations
- Cross-system interop where a resource server already accepts webcash (e.g., [harmoniis.com](https://harmoniis.com)) but the client speaks x402

## Network Identifiers

The x402 v2 specification encourages CAIP-2 format for non-blockchain networks (e.g., `ach:us`, `sepa:eu`). The `webcash` scheme defines:

- `webcash:mainnet` — the canonical webcash issuer at `https://webcash.org`
- `webcash:testnet` — reserved for testing/sandbox issuers

Custom issuers (forks or self-hosted) MAY override the default issuer URL via `extra.issuerUrl`. Facilitators MUST allowlist any non-canonical issuer.

## `paymentRequirements` Field Mappings

| Field               | Value for webcash                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `scheme`            | `"webcash"`                                                                                        |
| `network`           | `"webcash:mainnet"` or `"webcash:testnet"`                                                         |
| `amount`            | Integer string in **wats** (1 webcash = 10^8 wats); MUST exactly equal the amount in the secret    |
| `asset`             | `"webcash"`                                                                                        |
| `payTo`             | Issuer URL where settlement will occur (e.g., `"https://webcash.org"`)                             |
| `maxTimeoutSeconds` | Standard x402 field; SHOULD be at least the issuer round-trip time (typically 30–60s is generous) |
| `extra.issuerUrl`   | Optional override of the default issuer for the given `network`                                    |
| `extra.recipientPublicHash` | Optional pre-committed hash the resource server expects in the replacement output       |

The `payTo` URL MUST match the issuer implied by `network` unless `extra.issuerUrl` is set, in which case `payTo` MUST equal `extra.issuerUrl`.

### Example `PaymentRequired` response

```json
{
  "x402Version": 2,
  "error": "X-PAYMENT header is required",
  "resource": {
    "url": "https://api.example.com/premium",
    "description": "Premium endpoint paid in webcash",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "webcash",
      "network": "webcash:mainnet",
      "amount": "30000000",
      "asset": "webcash",
      "payTo": "https://webcash.org",
      "maxTimeoutSeconds": 60
    }
  ]
}
```

(`30000000` wats = 0.3 webcash.)

## `X-PAYMENT` Header Payload

The `X-PAYMENT` header carries a base64-encoded `PaymentPayload` JSON object (per the x402 v2 core specification). The scheme-specific `payload` field for `webcash` contains:

| Field    | Type     | Required | Description                                                       |
| -------- | -------- | -------- | ----------------------------------------------------------------- |
| `secret` | `string` | Required | Bearer secret in `e<amount>:secret:<hex>` form                    |

### Example `PaymentPayload`

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "webcash",
    "network": "webcash:mainnet",
    "amount": "30000000",
    "asset": "webcash",
    "payTo": "https://webcash.org",
    "maxTimeoutSeconds": 60
  },
  "payload": {
    "secret": "e0.3:secret:a1b2c3d4e5f6..."
  }
}
```

The amount embedded in `secret` (here, `0.3`) MUST match `accepted.amount` after unit conversion (decimal webcash → wats).

## Verification

The facilitator MUST perform the following verification steps in order. Verification MUST NOT replace the secret; replacement happens only at settlement.

1. **Format validation.** Parse `payload.secret` against the regex `^e(\d+(?:\.\d+)?):secret:[0-9a-f]+$`. Reject malformed secrets with `invalidReason: "invalid_payload"`.
2. **Amount match.** Convert the decimal amount embedded in the secret to wats and compare against `paymentRequirements.amount`. They MUST be exactly equal. Reject mismatches with `invalidReason: "invalid_webcash_amount_mismatch"`.
3. **Issuer match.** If `extra.issuerUrl` is set, it MUST equal `payTo`. The resolved issuer URL MUST be on the facilitator's allowlist.
4. **Issuer reachability.** The facilitator SHOULD verify the issuer is responsive (e.g., a small `POST /api/v1/health_check` round-trip) before declaring `isValid: true`. A failed health check returns `invalidReason: "issuer_unreachable"`.

### `VerifyResponse`

```json
{ "isValid": true }
```

`payer` is omitted — the webcash protocol is anonymous; there is no payer address.

## Settlement

Settlement is performed by calling the issuer's atomic-replacement endpoint with the input secret and one or more output secrets the resource server controls.

For `webcash.org`, the endpoint is `POST /api/v1/replace` with body:

```json
{
  "webcashes": ["e0.3:secret:<input-hex>"],
  "new_webcashes": ["e0.3:secret:<output-hex>"],
  "legalese": { "terms": true }
}
```

On success, the input secret is unspendable thereafter (issuer-enforced), and the output secret(s) are valid bearer tokens held by the resource server. Failure returns a 4xx response from the issuer.

### `SettlementResponse`

| Field         | Value                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `success`     | `true` iff the issuer accepted the replacement                                              |
| `transaction` | SHA-256 hash of the spent input secret (uniquely identifies the settlement event)           |
| `network`     | Echo of `paymentRequirements.network`                                                       |
| `amount`      | Echo of `paymentRequirements.amount` (wats)                                                 |
| `payer`       | Omitted (webcash is anonymous)                                                              |
| `errorReason` | On failure: `"insufficient_funds"`, `"invalid_payload"`, `"issuer_rejected"`, `"unexpected_settle_error"` |

`transaction` is the SHA-256 of the input secret — *not* a chain transaction hash — because webcash settlement does not produce one. This identifier is sufficient to look up the spend event in the issuer's audit log and is unique per spend.

## Security Considerations

### Replay attack prevention

Replay prevention is **issuer-enforced**, not chain-enforced. The webcash issuer maintains a registry of replaced secrets; any attempt to replace an already-replaced secret returns an error. Facilitators MUST treat any `/replace` failure as a settlement failure and MUST NOT retry with the same input secret.

The lifecycle of a secret on this rail is therefore:

```
unspent (held by client) ──verify──▶ unspent (still held)
                                     │
                                     └──settle──▶ replaced (held by server in new secret)
```

Verification is read-only and idempotent. Settlement is destructive and one-shot.

### Authorization scope

There is no separate signature or authorization step. Possession of the secret IS the authority to spend it. Clients MUST treat secrets as private credentials and transmit them only over secure channels (HTTPS, end-to-end-encrypted MCP transports, etc.).

A facilitator that observes a secret in flight (on `/verify` or `/settle`) is — until it calls `/replace` — capable of spending that secret itself. **Clients MUST trust their chosen facilitator** with the same level of trust they would give the funds. This is a sharper trust requirement than `exact`, where the facilitator at most submits a pre-signed authorization to chain.

### Settlement atomicity

The webcash `/replace` endpoint is atomic at the issuer: either the input is fully consumed and all outputs are fully created, or no state changes. Partial settlement is not possible.

### TLS

All communication between client, facilitator, and issuer MUST use TLS. Allowlisted issuer URLs MUST be HTTPS.

### Issuer trust

Webcash relies on a trusted issuer to maintain the spent-secret registry honestly. This is a sharper centralization assumption than the `exact` scheme makes; facilitators SHOULD make the issuer URL visible in `GET /supported` and clients SHOULD treat the issuer as part of their trusted set.

## Critical Validation Requirements

Facilitators MUST enforce:

- **Amount exactness.** The amount embedded in the secret MUST equal `paymentRequirements.amount` exactly. Surplus webcash MUST NOT be accepted; clients SHOULD pre-split with `/replace` to produce an exact-amount secret before payment.
- **Issuer authenticity.** Only verified issuer URLs (`https://webcash.org` for mainnet) are accepted. Arbitrary URLs in `extra.issuerUrl` MUST be allowlisted by the facilitator operator.
- **Format strictness.** The secret regex MUST be enforced; whitespace, unicode normalization tricks, or alternative encodings MUST be rejected.

## Error Codes

Scheme-specific error codes returned in `VerifyResponse.invalidReason` or `SettlementResponse.errorReason`:

- `invalid_webcash_amount_mismatch` — amount in secret does not equal `paymentRequirements.amount`
- `invalid_webcash_secret_format` — secret does not match `^e(\d+(?:\.\d+)?):secret:[0-9a-f]+$`
- `issuer_unreachable` — health check or `/replace` could not reach the issuer
- `issuer_rejected` — issuer returned an error (e.g., already-spent secret)

Generic x402 codes (`insufficient_funds`, `invalid_network`, `invalid_payload`, `invalid_scheme`, `unsupported_scheme`, `unexpected_verify_error`, `unexpected_settle_error`) apply unchanged.

## Appendix

### Comparison with `exact`

| Property              | `exact` (EVM)                               | `webcash`                              |
| --------------------- | ------------------------------------------- | -------------------------------------- |
| Authority mechanism   | EIP-712 signature                           | Possession of secret                   |
| Replay prevention     | On-chain nonce (EIP-3009)                   | Issuer-side spent-secret registry      |
| Settlement            | Broadcast `transferWithAuthorization`       | Issuer `POST /api/v1/replace`          |
| Settlement latency    | Block time                                  | Issuer round-trip (~ms)                |
| Trust model           | Trustless on settled chain                  | Trusts the issuer                      |
| Pre-funding           | Token balance                               | Pre-existing valid secret              |
| Anonymity             | Pseudonymous (wallet address visible)       | Anonymous (no payer identity)          |
| Facilitator trust     | Facilitator cannot steal pre-signed auth    | Facilitator MUST be trusted with funds |

### Reference issuer endpoints

The canonical webcash issuer at `https://webcash.org` exposes (subject to change; see https://webcash.org/api):

- `POST /api/v1/replace` — atomic swap of input secrets for output secrets (settlement)
- `POST /api/v1/health_check` — issuer health
- `POST /api/v1/target` — current proof-of-work mining difficulty (not used by this scheme)

### Open items

- **Issuer-URL allowlisting policy.** The reference facilitator hardcodes `webcash.org`; production deployments need a configurable allowlist with audit.
- **Issuer-side discovery.** No standard exists yet for a webcash issuer to advertise its endpoints; this scheme assumes `payTo` is a base URL with the standard webcash.org API shape.
- **Generalization to other bearer-secret rails.** A future `bearer-secret` scheme family could cover webcash, vouchers (e.g., harmoniis vouchers), and Lightning hold-invoices under one umbrella. Out of scope for this draft.

## References

- x402 v2 Core Specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 `exact` scheme: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact.md
- Webcash whitepaper and protocol: https://webcash.org
- Harmoniis (webcash-native agent marketplace): https://harmoniis.com
