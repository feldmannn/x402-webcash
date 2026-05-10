// Client-side wallet abstraction for spending webcash via x402.
//
// A wallet holds unspent bearer secrets. The client side needs only two
// operations: (1) atomically take a secret of an exact amount when a 402
// challenge arrives, and (2) put back a secret that turned out not to be
// spent (e.g. the server returned 402 with our X-PAYMENT, meaning settlement
// did not run). Persistence is the wallet's responsibility — middleware-side
// callbacks (`onSettled`/`onSettledRecovery`) handle the server-side path.
//
// This file ships a FileWallet (JSON file, single-process). Real deployments
// should swap in a SQLite-backed or keychain-backed wallet that supports
// concurrent access and OS-level secret protection.

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
  /** Persist a secret to the wallet. */
  put(secret: string): Promise<void>;
  /** Return the list of held secrets (for diagnostics/testing). */
  list(): Promise<string[]>;
}

/**
 * File-backed JSON wallet. Reads and writes the whole file on each
 * operation, using a temp-file + rename for write atomicity. Safe for a
 * single process; concurrent writers from multiple processes will race
 * and can lose secrets. Use SQLite or a keychain wallet for production.
 *
 * File shape: `{ "secrets": ["e<amount>:secret:<hex>", ...] }`.
 */
export class FileWallet implements Wallet {
  constructor(private readonly path: string) {}

  private async read(): Promise<string[]> {
    let buf: string;
    try {
      buf = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
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
  }

  async put(secret: string): Promise<void> {
    if (parseSecret(secret) === null) {
      throw new Error("refusing to put malformed secret into wallet");
    }
    const secrets = await this.read();
    secrets.push(secret);
    await this.write(secrets);
  }

  async list(): Promise<string[]> {
    return this.read();
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
