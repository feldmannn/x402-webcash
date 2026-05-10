// Full-stack integration test: fake webcash issuer + facilitator + paywall
// middleware, all wired over real HTTP. Proves the SUCCESS path end-to-end —
// the one thing the unit tests (with mocked fetch) and the live smoke test
// (against real webcash.org with a fake secret) couldn't cover together.
//
// What this proves:
//   - X-PAYMENT base64 → middleware decode
//   - middleware → facilitator HTTP round-trip
//   - facilitator → issuer HTTP round-trip (real fetch over real sockets)
//   - issuer 200 + faithful response body parsing
//   - mintOutputSecret invocation
//   - SettlementResponse.extensions.webcashOutput surfaced through HTTP
//   - middleware integrity check passes (output present, well-formed)
//   - onSettled invocation with the right payload
//   - 200 response + X-PAYMENT-RESPONSE header round-trip
//
// What this does NOT prove: webcash.org's specific server-side semantics.
// Those are taken from kanzure/webcash source (verified separately).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import express from "express";
import { Facilitator } from "../src/facilitator.js";
import { paywall, type WebcashOutput } from "../src/middleware.js";
import { newOutputSecret } from "../src/webcash.js";
import type { FacilitatorRequest } from "../src/types.js";

type Listening = { url: string; close: () => Promise<void> };

async function listen(app: express.Express): Promise<Listening> {
  return new Promise((resolveStart) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

type FakeIssuer = Listening & { calls: { health: number; replace: number }; lastReplaceBody: unknown };

async function startFakeIssuer(): Promise<FakeIssuer> {
  const calls = { health: 0, replace: 0 };
  let lastReplaceBody: unknown = null;
  const app = express();
  app.use(express.json());
  app.post("/api/v1/health_check", (_req, res) => {
    calls.health += 1;
    res.json({ status: "success", results: {} });
  });
  app.post("/api/v1/replace", (req, res) => {
    calls.replace += 1;
    lastReplaceBody = req.body;
    // Match the real webcash.org happy-path shape (200 + minimal success body).
    res.json({ status: "success" });
  });
  const base = await listen(app);
  return {
    ...base,
    calls,
    get lastReplaceBody() {
      return lastReplaceBody;
    },
  };
}

async function startFacilitator(issuerUrl: string): Promise<Listening> {
  const facilitator = new Facilitator({ issuerAllowlist: [issuerUrl] });
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => res.json(facilitator.supported()));
  app.post("/verify", async (req, res) => {
    res.json(await facilitator.verify(req.body as FacilitatorRequest));
  });
  app.post("/settle", async (req, res) => {
    res.json(await facilitator.settle(req.body as FacilitatorRequest));
  });
  return listen(app);
}

type ResourceServer = Listening & { settled: WebcashOutput[] };

async function startResource(facilitatorUrl: string, issuerUrl: string): Promise<ResourceServer> {
  const settled: WebcashOutput[] = [];
  const app = express();
  app.get(
    "/premium",
    paywall({
      amountWats: 30_000_000n, // 0.3 webcash
      facilitatorUrl,
      payTo: issuerUrl,
      extra: { issuerUrl },
      onSettled: (o) => {
        settled.push(o);
      },
    }),
    (_req, res) => res.json({ ok: true, secret: "the answer is 42" }),
  );
  const base = await listen(app);
  return { ...base, settled };
}

function fetchRaw(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; bodyText: string }> {
  return new Promise((resolveReq, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: init.method ?? "GET", headers: init.headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolveReq({ status: res.statusCode ?? 0, headers: res.headers, bodyText: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function encodePayload(secret: string, payTo: string, extra?: Record<string, unknown>): string {
  const accepted: Record<string, unknown> = {
    scheme: "webcash",
    network: "webcash:mainnet",
    amount: "30000000",
    asset: "webcash",
    payTo,
    maxTimeoutSeconds: 60,
  };
  if (extra) accepted.extra = extra;
  const payload = {
    x402Version: 2,
    accepted,
    payload: { secret },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

test("full happy-path: paywalled endpoint serves the resource on valid payment", async () => {
  const issuer = await startFakeIssuer();
  const facilitator = await startFacilitator(issuer.url);
  const resource = await startResource(facilitator.url, issuer.url);
  try {
    // Probe — must return 402 with payment requirements.
    const probe = await fetchRaw(`${resource.url}/premium`);
    assert.equal(probe.status, 402);
    const probeBody = JSON.parse(probe.bodyText) as { x402Version: number; accepts: Array<{ payTo: string; extra?: { issuerUrl?: string } }> };
    assert.equal(probeBody.x402Version, 2);
    assert.equal(probeBody.accepts[0]!.payTo, issuer.url);
    assert.equal(probeBody.accepts[0]!.extra?.issuerUrl, issuer.url);
    assert.equal(issuer.calls.replace, 0);

    // Pay — should succeed end-to-end.
    const inputSecret = "e0.3:secret:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const r = await fetchRaw(`${resource.url}/premium`, {
      headers: {
        "X-PAYMENT": encodePayload(inputSecret, issuer.url, { issuerUrl: issuer.url }),
      },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.bodyText}`);
    assert.deepEqual(JSON.parse(r.bodyText), { ok: true, secret: "the answer is 42" });

    // Issuer received exactly one /replace with the right shape.
    assert.equal(issuer.calls.replace, 1);
    const issuerBody = issuer.lastReplaceBody as { webcashes: string[]; new_webcashes: string[]; legalese: { terms: boolean } };
    assert.deepEqual(issuerBody.webcashes, [inputSecret]);
    assert.equal(issuerBody.new_webcashes.length, 1);
    assert.match(issuerBody.new_webcashes[0]!, /^e0\.3:secret:[0-9a-f]{64}$/);
    assert.deepEqual(issuerBody.legalese, { terms: true });

    // Resource server's onSettled was called with the SAME output secret the
    // issuer was asked to mint — proving the secret round-tripped intact.
    assert.equal(resource.settled.length, 1);
    assert.equal(resource.settled[0]!.secret, issuerBody.new_webcashes[0]);
    assert.equal(resource.settled[0]!.amountWats, "30000000");
    assert.equal(resource.settled[0]!.amountDecimal, "0.3");

    // X-PAYMENT-RESPONSE header is set and decodes to a SettlementResponse
    // that echoes the same output secret.
    const xpr = r.headers["x-payment-response"];
    assert.ok(typeof xpr === "string");
    const settled = JSON.parse(Buffer.from(xpr as string, "base64").toString("utf8")) as {
      success: boolean;
      transaction: string;
      extensions?: { webcashOutput?: { secret: string } };
    };
    assert.equal(settled.success, true);
    assert.match(settled.transaction, /^[0-9a-f]{64}$/);
    assert.equal(settled.extensions?.webcashOutput?.secret, issuerBody.new_webcashes[0]);
  } finally {
    await resource.close();
    await facilitator.close();
    await issuer.close();
  }
});

test("full happy-path with deterministic mintOutputSecret yields a known output", async () => {
  const issuer = await startFakeIssuer();
  const expectedOutput = newOutputSecret("0.3");
  // Override the facilitator to mint a specific output we can assert against.
  const facilitator = new Facilitator({
    issuerAllowlist: [issuer.url],
    mintOutputSecret: () => expectedOutput,
  });
  const fapp = express();
  fapp.use(express.json());
  fapp.post("/settle", async (req, res) => res.json(await facilitator.settle(req.body as FacilitatorRequest)));
  const fac = await listen(fapp);
  const resource = await startResource(fac.url, issuer.url);
  try {
    const inputSecret = "e0.3:secret:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const r = await fetchRaw(`${resource.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload(inputSecret, issuer.url, { issuerUrl: issuer.url }) },
    });
    assert.equal(r.status, 200);
    assert.equal(resource.settled[0]!.secret, expectedOutput);
    const issuerBody = issuer.lastReplaceBody as { new_webcashes: string[] };
    assert.equal(issuerBody.new_webcashes[0], expectedOutput);
  } finally {
    await resource.close();
    await fac.close();
    await issuer.close();
  }
});

test("full path: issuer rejects → 402 issuer_rejected, no persistence", async () => {
  const issuer = await listen((() => {
    const app = express();
    app.use(express.json());
    app.post("/api/v1/health_check", (_req, res) => res.json({ status: "success" }));
    app.post("/api/v1/replace", (_req, res) => res.status(400).json({ error: "secret already spent" }));
    return app;
  })());
  const facilitator = await startFacilitator(issuer.url);
  const resource = await startResource(facilitator.url, issuer.url);
  try {
    const r = await fetchRaw(`${resource.url}/premium`, {
      headers: {
        "X-PAYMENT": encodePayload(
          "e0.3:secret:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          issuer.url,
          { issuerUrl: issuer.url },
        ),
      },
    });
    assert.equal(r.status, 402);
    const body = JSON.parse(r.bodyText) as { error: string };
    assert.match(body.error, /issuer_rejected|secret already spent/);
    assert.equal(resource.settled.length, 0, "onSettled must NOT fire on issuer rejection");
  } finally {
    await resource.close();
    await facilitator.close();
    await issuer.close();
  }
});
