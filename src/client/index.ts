// Public surface of the client-side scheme handler.
//
// The fetch wrapper is the primary consumer entry point. For non-fetch
// transports (axios, undici Dispatcher, MCP transports), compose
// `buildWebcashHeader` directly: it returns the base64 X-PAYMENT header
// and the matching secret so the caller can wire the retry however they
// like.

export { buildWebcashHeader, NoMatchingSecretError, WEBCASH_SCHEME } from "./scheme.js";
export type { BuiltHeader } from "./scheme.js";
export { wrapFetchWithWebcash } from "./fetch.js";
export type { WrapFetchOptions } from "./fetch.js";
export { FileWallet, MemoryWallet } from "./wallet.js";
export type { Wallet } from "./wallet.js";
