# Scheme: `webcash`

**Status:** v1 — feature-complete reference implementation; ready for upstream proposal to `coinbase/x402`.
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

`network` MUST start with the literal `webcash:` namespace. Facilitators MUST reject `paymentRequirements` whose `network` is outside this namespace, even if `extra.issuerUrl` is set to an allowlisted URL.

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
| `extra.issuerUrl`           | Optional override of the default issuer for the given `network`                                    |
| `extra.recipientPublicKey`  | Optional. Base64-encoded raw X25519 public key the resource server uses for recipient binding; see "Recipient binding" below |
| `extra.recipientNonce`      | Required if `recipientPublicKey` is set. Per-challenge fresh nonce (base64url, ≥16 bytes recommended) |
| `extra.recipientPublicHash` | (Set by buyer in `accepted.extra`, not by server.) `base64(SHA-256(outputSecret))` precommitment; binds the facilitator to a specific output secret |

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

| Field             | Type     | Required                       | Description                                                                                                                                                                  |
| ----------------- | -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret`          | `string` | Required                       | Bearer secret in `e<amount>:secret:<hex>` form                                                                                                                               |
| `outputSecret`    | `string` | Required when `accepted.extra.recipientPublicHash` is set; otherwise absent | The output secret the facilitator MUST use in `/replace` (instead of minting one). See "Recipient binding"                                              |
| `buyerPublicKey` | `string` | Required when `outputSecret` is set | Base64-encoded raw X25519 public key the resource server uses to re-derive and verify `outputSecret` post-settlement                                                  |

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

1. **Format validation.** Parse `payload.secret` against the regex `^e(\d+)(?:\.(\d{1,8}))?:secret:[0-9a-f]+$`. The fractional part is at most 8 digits (wat precision); whitespace and uppercase hex MUST be rejected. Zero-amount secrets MUST be rejected. On failure return `invalidReason: "invalid_webcash_secret_format"`.
2. **Cross-check `paymentPayload.accepted`.** Its `scheme`, `network`, `payTo`, `amount`, and `asset` MUST all equal those of `paymentRequirements`. On any mismatch return `invalidReason: "invalid_payload"`.
3. **Amount match.** Convert the decimal amount embedded in the secret to wats and compare against `paymentRequirements.amount`. They MUST be exactly equal. Reject mismatches with `invalidReason: "invalid_webcash_amount_mismatch"`.
4. **Issuer match.** The resolved issuer URL (either `extra.issuerUrl` if set, otherwise the canonical URL for `network`) MUST equal `payTo` AND MUST be on the facilitator's allowlist. On mismatch return `invalidReason: "invalid_network"`.
5. **Issuer reachability.** The facilitator SHOULD verify the issuer is responsive (e.g., a `POST /api/v1/health_check` round-trip, ideally cached with a short TTL) before declaring `isValid: true`. A failed health check returns `invalidReason: "issuer_unreachable"`.

Settlement skips step 5 — the `/replace` call below is itself the round-trip that proves issuer reachability — but performs steps 1–4.

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

The `legalese` field MUST contain the issuer's required disclosure acknowledgements. For `webcash.org` this is `{ "terms": true }` (per the canonical webcash client's `LEGALESE` constant in `webcashbase.py`). Forks of the issuer with different disclosures will reject the request with an `invalid_legalese`-style error; facilitators MUST allow this object to be configured.

The output secret MUST be minted before the `/replace` call so a failure to mint cannot leave the input spent without a recoverable output.

On success, the input secret is unspendable thereafter (issuer-enforced), and the output secret(s) are valid bearer tokens held by the resource server. Failure returns a 4xx response from the issuer.

### Persistence atomicity (resource-server side)

A successful `/replace` response is the point of no return — the input secret is permanently spent. The resource server MUST persist the output secret to a durable store before considering the transaction settled. If persistence fails, the server MUST:

1. Write the output secret to a recovery sink that is independent of the primary persistence (different disk, different DB, off-host log, etc.).
2. As an absolute last resort, log the secret to stderr with a recognizable marker (`[x402-webcash][CRITICAL]` is suggested) so an operator can grep logs to recover.
3. Return HTTP 500 — **not** 402 — to the client. 402 invites a retry, but the input secret is already spent and no retry can succeed; 500 signals a server-side failure that requires operator action.

### `SettlementResponse`

| Field         | Value                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `success`     | `true` iff the issuer accepted the replacement                                              |
| `transaction` | SHA-256 hash of the spent input secret (uniquely identifies the settlement event)           |
| `network`     | Echo of `paymentRequirements.network`                                                       |
| `amount`      | Echo of `paymentRequirements.amount` (wats)                                                 |
| `payer`       | Omitted (webcash is anonymous)                                                              |
| `errorReason` | On failure: `"insufficient_funds"`, `"invalid_payload"`, `"issuer_rejected"`, `"unexpected_settle_error"` |
| `extensions.webcashOutput` | On success: the newly-minted output secret the resource server now owns (see below)       |

`transaction` is the SHA-256 of the input secret — *not* a chain transaction hash — because webcash settlement does not produce one. This identifier is sufficient to look up the spend event in the issuer's audit log and is unique per spend.

#### `extensions.webcashOutput`

On a successful settlement the facilitator MUST return the bearer secret that now holds the settled funds, so that the resource server can persist it to a wallet. Without this, the funds are unrecoverable.

| Field           | Type     | Description                                                  |
| --------------- | -------- | ------------------------------------------------------------ |
| `secret`        | `string` | The new output secret in `e<amount>:secret:<hex>` form        |
| `amountDecimal` | `string` | Amount in decimal webcash (e.g., `"0.3"`)                    |
| `amountWats`    | `string` | Amount in wats as a decimal string (echoes `amount`)         |

```json
{
  "success": true,
  "transaction": "9f86d081...",
  "network": "webcash:mainnet",
  "amount": "30000000",
  "extensions": {
    "webcashOutput": {
      "secret": "e0.3:secret:b2c3d4e5...",
      "amountDecimal": "0.3",
      "amountWats": "30000000"
    }
  }
}
```

**Resource servers MUST persist `extensions.webcashOutput.secret` to a wallet before considering the transaction complete.** A successful 200 response without persistence is an irrecoverable loss of funds.

**A `success: true` response without `extensions.webcashOutput` (or with a malformed one) is a settlement-integrity failure.** The facilitator either lost or stole the new bearer secret. Resource servers MUST treat this as a fatal server-side error: do NOT serve the resource, return HTTP 500 (NOT 402), and log the transaction id to a recovery channel. Returning 402 invites a client retry that cannot succeed because the input secret is already spent at the issuer.

## Recipient binding

The baseline `webcash` flow lets the facilitator choose the output secret on `/replace`. A malicious or compromised facilitator can therefore substitute a secret it controls and pocket the funds. Two mitigations close this hole:

- **In-process facilitator.** The resource server hosts the facilitator itself (no third party in the trust set). The resource server controls `mintOutputSecret` directly. This is the strongest model and is supported via the `paywallLocal(facilitator, opts)` helper in the reference implementation.
- **Recipient binding.** A remote facilitator can be cryptographically constrained to use a specific output secret derived by the buyer from an ECDH key exchange with the resource server. The facilitator never gets to choose the output; if it substitutes, the resource server's post-settlement verification detects the substitution.

The rest of this section describes the binding protocol.

### Protocol

When the resource server wants to use a remote facilitator under binding:

1. **Server publishes pubkey + nonce in 402.** The resource server generates (or reuses) an X25519 keypair and includes its public key and a fresh per-challenge nonce in `paymentRequirements.extra`:

   ```json
   "extra": {
     "recipientPublicKey": "<base64 raw X25519 pubkey, 32 bytes>",
     "recipientNonce":     "<base64url nonce, ≥16 bytes>"
   }
   ```

2. **Buyer derives a bound output secret.** The buyer generates an ephemeral X25519 keypair, computes the ECDH shared secret with `recipientPublicKey`, then derives the output secret hex via HKDF-SHA256:

   ```
   shared      = ECDH(buyer_priv, server_pub)
   salt        = recipientNonce       (UTF-8 bytes)
   info        = "x402-webcash:v1:" + recipientNonce + ":" + amountDecimal
   output_hex  = HKDF-SHA256(shared, salt, info, L=32)
   outputSecret = "e" + amountDecimal + ":secret:" + hex(output_hex)
   ```

   The HKDF parameters are exact and normative — both buyer and recipient MUST use the same byte-for-byte construction or verification will fail.

3. **Buyer includes the binding fields in the payment.**

   ```json
   "accepted": {
     ...,
     "extra": {
       "recipientPublicKey": "<echoed>",
       "recipientNonce":     "<echoed>",
       "recipientPublicHash": "<base64(SHA-256(outputSecret_string))>"
     }
   },
   "payload": {
     "secret":         "<buyer's input secret>",
     "outputSecret":   "<derived output secret>",
     "buyerPublicKey": "<base64 raw X25519 buyer pubkey, 32 bytes>"
   }
   ```

4. **Facilitator enforces the hash binding.** When `accepted.extra.recipientPublicHash` is present, the facilitator MUST:
   - Reject the request if `payload.outputSecret` is missing.
   - Reject the request if `base64(SHA-256(outputSecret_string))` does not equal `recipientPublicHash`.
   - Reject the request if the amount embedded in `outputSecret` does not equal `paymentRequirements.amount` (after unit conversion).
   - Use `payload.outputSecret` as the output of `/replace`. The facilitator MUST NOT mint its own output.

5. **Resource server verifies post-settlement.** After a successful settlement the resource server re-derives the expected output secret from `recipientPrivateKey + payload.buyerPublicKey + recipientNonce + amountDecimal` (using the same HKDF construction above) and compares against `settled.extensions.webcashOutput.secret`. A mismatch indicates the facilitator returned a secret that does not match the buyer's commitment — the resource server MUST respond HTTP 500 (not 402) and log a CRITICAL marker. The funds may have settled at the issuer but they are NOT controlled by this resource server.

### Threat model and residual risk

Binding constrains the facilitator to use a specific output secret. It does NOT prevent the facilitator from briefly knowing that secret — by construction the facilitator must put it in `/replace`'s `new_webcashes`. The facilitator could therefore race to spend the output between `/replace` returning and the resource server refreshing the secret into its own wallet.

Mitigations:

- The resource server's `onSettled` SHOULD immediately refresh the secret to a wallet-controlled secret via a second `/replace(input=output, output=fresh)` call. The shorter the time between settlement and refresh, the smaller the race window.
- Deploy the facilitator with low network distance to your wallet's refresh path.
- Use `paywallLocal` (in-process facilitator) whenever the race window is unacceptable.

Detection: a successful race-spend by the facilitator manifests as the resource server's refresh `/replace` failing with the issuer's `already-replaced` error. The CRITICAL log from this failure is a clear signal the facilitator is dirty.

### Reference implementation

The reference TypeScript implementation exposes:

- `RecipientKey.generate()`, `RecipientKey.fromJwk(...)`, `recipientKey.publicKeyBase64`, `RecipientKey.newNonce()`
- `buildBoundOutput({ recipientPublicKey, recipientNonce, amountDecimal })` — buyer-side derivation
- `paywall({ recipientKey })` and `paywallLocal(facilitator, { recipientKey })` — server-side; auto-publishes the binding challenge and verifies after settlement
- The client-side `buildWebcashHeader` / `wrapFetchWithWebcash` auto-derive bound outputs whenever the 402 challenge advertises `recipientPublicKey` + `recipientNonce`

See `src/recipient.ts`.

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

All communication between client, facilitator, and issuer MUST use TLS. Allowlisted issuer URLs MUST be HTTPS (loopback HTTP is permitted only for in-process test rigs).

Implementations SHOULD support SPKI (RFC 7469) certificate pinning on every HTTPS leg they make: facilitator → issuer, paywall middleware → facilitator, client splitter → issuer. Pinning is additive — the default CA chain validation still runs first; the pin is an extra check. Operators SHOULD configure at least two pins per endpoint (current + backup) so a planned key rotation is not an outage.

The reference implementation exposes `pinnedSpkiHashes?: readonly string[]` on `FacilitatorOptions`, `PaywallOptions`, `SplitOptions`, and `AutoSplitOptions`, and a `createPinnedFetch({ pinnedSpkiHashes })` factory for callers using custom transports.

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

- **Issuer-side discovery.** No standard exists yet for a webcash issuer to advertise its endpoints; this scheme assumes `payTo` is a base URL with the standard webcash.org API shape.
- **Generalization to other bearer-secret rails.** A future `bearer-secret` scheme family could cover webcash, vouchers (e.g., harmoniis vouchers), and Lightning hold-invoices under one umbrella. Out of scope for this draft.

### Client-side persistence

Client implementations SHOULD journal the bearer secret to a durable store immediately after taking it from the wallet and before the network request is sent. The takeExact -> request -> response window is the equivalent client-side risk of the server-side "funds-already-moved" path: if the process crashes mid-request, the secret is no longer in the wallet but has not yet been spent at the issuer, and on restart the client has no way to know which secrets are in flight. The reference client (`wrapFetchWithWebcash`) exposes a `journal` hook for exactly this purpose.

## References

- x402 v2 Core Specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- x402 `exact` scheme: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact.md
- Webcash whitepaper and protocol: https://webcash.org
- Harmoniis (webcash-native agent marketplace): https://harmoniis.com
