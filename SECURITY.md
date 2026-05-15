# Security model

This document describes what `x402-webcash` defends against, what it doesn't, and how to report vulnerabilities.

## Trust assumptions

Webcash is a bearer-token system: possession of a secret is the authority to spend it. Anything that sees a secret can spend it. The threat model therefore centers on who sees a secret and when.

Roles:

- **Buyer.** Holds input secrets in a local wallet. Submits a payment to a resource server.
- **Resource server.** Paywalls an HTTP endpoint or MCP tool. Receives the output secret after settlement.
- **Facilitator.** Talks to the issuer's `/replace` endpoint on behalf of the resource server. May be co-located with the resource server (in-process) or run remotely.
- **Issuer.** The canonical webcash issuer at `https://webcash.org` (or a fork). Authoritative for "is this secret spent."

The issuer is always in the trusted set. Webcash by design does not eliminate this trust.

## What this library defends against

**Bearer-secret leakage on the wire.**

- All HTTP fetches to issuer and facilitator URLs reject non-HTTPS schemes (loopback HTTP is allowed only for test rigs and requires an explicit opt-in flag). A misconfigured URL throws at construction time rather than silently transmitting a secret in plaintext.
- `pinnedSpkiHashes` (on `Facilitator`, `paywall`, `paywallLocal`, `splitToMatch`, and `autoSplit`) cryptographically pins the TLS server's SubjectPublicKeyInfo. A CA-mis-issued certificate cannot complete the handshake; the secret is never transmitted.

**Facilitator substitution of the output secret.**

A remote facilitator can in principle put any output secret in `/replace`'s `new_webcashes`, return success to the resource server, and pocket the funds. Mitigations:

- **In-process facilitator (`paywallLocal`).** The resource server hosts the facilitator. No third party can substitute anything.
- **Recipient binding.** The resource server publishes an X25519 public key + nonce in the 402 challenge; the buyer derives the output secret via ECDH+HKDF; the facilitator is required to use that exact secret (a hash precommitment is checked); the resource server verifies post-settlement that the returned secret matches what its private key would derive. Substitution is detected and the request fails 500 with a CRITICAL log. See `specs/scheme_webcash.md` for the protocol and `src/recipient.ts` for the implementation.

**Wrong-amount output secrets.**

A buggy or compromised facilitator could return a smaller-amount output than the buyer was charged for. The `webcashSettler` adapter and the facilitator's own `/settle` path both verify that `parseSecret(output).wats === requirements.amount` and reject the settlement otherwise.

**Double-spend across concurrent requests.**

`FileWallet` serializes `takeExact` / `put` / `take` operations through an in-process mutex. Multiple concurrent `takeExact` calls cannot return the same secret. (Not safe across processes — use a SQLite or keychain-backed wallet for multi-process deployments.)

**Lost output secrets on persistence failure.**

Every fund-loss path is instrumented:

- A `success: true` response without `extensions.webcashOutput` produces HTTP 500 (NOT 402 — a retry cannot succeed because the input secret is already spent) plus a `[x402-webcash][CRITICAL]` log entry with the transaction id.
- An `onSettled` throw fires `onSettledRecovery` (caller-supplied last-resort sink) and logs the secret to stderr.
- Client-side, the `journal` hook fires after `takeExact` but before the X-PAYMENT retry is sent, so a process crash mid-request can be reconciled.

**Replay of `wrapFetchWithWebcash` retries.**

A retry that returns an ambiguous status (non-2xx, non-402) does NOT return the secret to the wallet (it may have been spent at the issuer). The secret is surfaced to a caller-supplied `onAmbiguous` hook and logged with `[x402-webcash][CRITICAL]`.

## What this library does NOT defend against

**A compromised issuer.** Webcash's whole security model rests on the issuer's spent-secret registry. If the issuer is malicious or compromised, no client-side mitigation can save you.

**A compromised facilitator paired with binding's race window.** Even with recipient binding, a malicious facilitator briefly knows the buyer-derived output secret between `/replace` returning and the resource server refreshing it. A facilitator with low network distance to the issuer could race a second `/replace` (spending the secret as its own input) before the resource server refreshes. Mitigations:

- The resource server's `onSettled` SHOULD refresh the secret to a wallet-controlled secret immediately. The shorter the window, the smaller the attack surface.
- Co-locate the resource server's refresh path with the issuer if possible.
- Use `paywallLocal` when the race window is unacceptable.

**Process-level secret extraction.** If an attacker can read your process memory, they can read your wallet. This library does no in-memory encryption.

**Loss of wallet files at rest.** `FileWallet` writes secrets to disk as plaintext JSON. Use filesystem encryption (e.g., LUKS, FileVault, BitLocker) or a hardware-backed keystore wallet for production deployments. The `Wallet` interface is the integration point for custom backends.

**Third-party JavaScript supply-chain attacks.** Dependencies are kept minimal (`express`, `undici`) but auditing them is the operator's responsibility.

## Reporting a vulnerability

Email `nate.feldmann@gmail.com` with `[x402-webcash security]` in the subject line. Please include:

- A description of the issue.
- Steps to reproduce.
- The version (`npm view x402-webcash version` and the commit hash if working from source).

I will acknowledge within 7 days and aim to ship a fix within 30 days for high-severity issues. If the issue is in the spec (not the implementation), I will coordinate disclosure with downstream implementers before fixing.

PGP not currently offered. Encrypted email via [age](https://age-encryption.org) is welcome if you prefer — open an issue (without details) asking for a public key and I'll post one.
