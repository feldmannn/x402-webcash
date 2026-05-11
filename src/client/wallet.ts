// Client-side wallet abstraction for spending webcash via x402.
//
// A wallet holds unspent bearer secrets. The client side needs only two
// operations: (1) atomically take a secret of an exact amount when a 402
// challenge arrives, and (2) put back a secret that turned out not to be
// spent (e.g. the server returned 402 with our X-PAYMENT, meaning settlement
// did not run). Persistence is the wallet's responsibility — middleware-side
// callbacks (`onSettled`/`onSettledRecovery`) handle the server-side path.
//
// Concurrency model: FileWallet serializes every operation via an
// in-process mutex. Two concurrent takeExact/take/put calls from the same
// process will run one after the other, so a wallet with N matching
// secrets handed to N concurrent callers will return one secret to each
// — never the same secret to two callers, and never a clobbered write.
//
// FileWallet is NOT safe for concurrent use ACROSS processes. Two node
// processes pointed at the same wallet file will race at the filesystem
// layer and can lose secrets. For multi-process deployments use a
// SQLite-backed or keychain-backed wallet implementing the Wallet
// interface; the contract this module relies on is exactly the four
// methods below.

import { promises as fs } from "node:fs";
import { parseSecret } from "../webcash.js";

export interface Wallet {
  /**
   * Atomically remove and return a secret whose embedded amount exactly
   * equals `wats`. Returns null if no such secret exists. Callers MUST
   * treat the returned secret as if it has been spent — if the request
   * the secret was taken for ultimately did not settle, call `put` to
   * return it to the wallet.
   */
  takeExact(wats: string): Promise<string | null>;
  /**
   * Atomically remove a specific secret. Returns true if it was present
   * and removed, false if it was not in the wallet. Used by split logic:
   * the caller picks a specific larger secret to consume, then takes it
   * out by value before calling `/replace` at the issuer.
   */
  take(secret: string): Promise<boolean>;
  /** Persist a secret to the wallet. */
  put(secret: string): Promise<void>;
  /** Return the list of held secrets (for diagnostics/testing). */
  list(): Promise<string[]>;
}

/**
 * File-backed JSON wallet. Reads and writes the whole file on each
 * operation, using a temp-file + rename for write atomicity. Operations
 * are serialized via an in-process mutex so concurrent callers from the
 * same process cannot double-spend or clobber each other's writes.
 *
 * NOT safe for concurrent use ACROSS processes. See file header comment.
 *
 * File shape: `{ "secrets": ["e<amount>:secret:<hex>", ...] }`.
 */
export class FileWallet implements Wallet {
  // Per-instance serialization chain. Every public method appends its
  // work to this promise so operations run one-at-a-time. We never read
  // the resolved value; the chain exists only to gate execution order.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  /**
   * Append `work` to the serialization chain and return its result. The
   * chain absorbs rejections so a thrown handler does not poison
   * subsequent operations.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    // Swallow errors on the chain itself; callers see them via the
    // returned promise.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<string[]> {
    let buf: string;
    try {
      buf = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // Strip UTF-8 BOM: Windows tools (PowerShell's `Set-Content -Encoding utf8`,
    // some editors) write UTF-8 with a leading BOM that JSON.parse rejects.
    if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf);
    } catch {
      throw new Error(`wallet file ${this.path} is not valid JSON`);
    }
    const secrets = (parsed as { secrets?: unknown })?.secrets;
    if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === "string")) {
      throw new Error(`wallet file ${this.path} must contain { "secrets": string[] }`);
    }
    return secrets;
  }

  private async write(secrets: string[]): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ secrets }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  async takeExact(wats: string): Promise<string | null> {
    return this.serialize(async () => {
      const target = BigInt(wats);
      const secrets = await this.read();
      const idx = secrets.findIndex((s) => {
        const parsed = parseSecret(s);
        return parsed !== null && parsed.wats === target;
      });
      if (idx < 0) return null;
      const [picked] = secrets.splice(idx, 1);
      await this.write(secrets);
      return picked!;
    });
  }

  async take(secret: string): Promise<boolean> {
    return this.serialize(async () => {
      const secrets = await this.read();
      const idx = secrets.indexOf(secret);
      if (idx < 0) return false;
      secrets.splice(idx, 1);
      await this.write(secrets);
      return true;
    });
  }

  async put(secret: string): Promise<void> {
    if (parseSecret(secret) === null) {
      throw new Error("refusing to put malformed secret into wallet");
    }
    await this.serialize(async () => {
      const secrets = await this.read();
      secrets.push(secret);
      await this.write(secrets);
    });
  }

  async list(): Promise<string[]> {
    return this.serialize(() => this.read());
  }
}

/**
 * In-memory wallet, useful for tests and short-lived agents. Secrets are
 * lost when the process exits — do NOT use for non-toy amounts.
 */
export class MemoryWallet implements Wallet {
  private secrets: string[];

  constructor(initial: string[] = []) {
    for (const s of initial) {
      if (parseSecret(s) === null) {
        throw new Error("refusing to seed MemoryWallet with a malformed secret");
      }
    }
    this.secrets = [...initial];
  }

  async takeExact(wats: string): Promise<string | null> {
    const target = BigInt(wats);
    const idx = this.secrets.findIndex((s) => {
      const parsed = parseSecret(s);
      return parsed !== null && parsed.wats === target;
    });
    if (idx < 0) return null;
    return this.secrets.splice(idx, 1)[0]!;
  }

  async take(secret: string): Promise<boolean> {
    const idx = this.secrets.indexOf(secret);
    if (idx < 0) return false;
    this.secrets.splice(idx, 1);
    return true;
  }

  async put(secret: string): Promise<void> {
    if (parseSecret(secret) === null) {
      throw new Error("refusing to put malformed secret into wallet");
    }
    this.secrets.push(secret);
  }

  async list(): Promise<string[]> {
    return [...this.secrets];
  }
}
