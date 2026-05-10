// Example: a stdio MCP server that exposes a paid HTTP endpoint as an
// MCP tool, settling each call in webcash via the x402 wrapped fetch.
//
// Three-process demo (each in its own terminal):
//   1. `npm run facilitator`     — facilitator on :4021
//   2. `npm run example`         — paywalled resource server on :4020
//   3. `npm run example:mcp`     — this file (stdio MCP server)
//
// Then point an MCP client at process #3. For Claude Desktop, add to
// claude_desktop_config.json:
//
//   {
//     "mcpServers": {
//       "x402-webcash-demo": {
//         "command": "npx",
//         "args": ["tsx", "/absolute/path/to/examples/mcp-server.ts"],
//         "env": { "WEBCASH_WALLET": "/absolute/path/to/client-wallet.json" }
//       }
//     }
//   }
//
// Calling the `get-premium-data` tool from the client will trigger a 402
// from the resource server; the wrapped fetch takes a webcash secret from
// the wallet (auto-splitting a larger one if needed), retries with
// X-PAYMENT, and returns the 200 body to the agent.
//
// Wallet setup: seed an unspent webcash secret into the wallet file
// before first use:
//   echo '{"secrets":["e1:secret:<your-hex>"]}' > ./client-wallet.json
// Auto-split is on by default, so any denomination >= 0.3 webcash works.

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileWallet, NoMatchingSecretError, wrapFetchWithWebcash } from "../src/client/index.js";

const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://localhost:4020/premium";
const WALLET_FILE = resolve(process.env.WEBCASH_WALLET ?? "./client-wallet.json");

const wallet = new FileWallet(WALLET_FILE);
const pay = wrapFetchWithWebcash(fetch, {
  wallet,
  // Auto-split is on by default for the demo so users don't need to
  // pre-stage exact denominations. Set autoSplit=undefined to require
  // exact-amount secrets only.
  autoSplit: {},
  onAmbiguous: ({ secret, status }) => {
    // eslint-disable-next-line no-console
    console.error(
      `[x402-webcash][MCP-QUARANTINE] status=${status} secret=${secret} — ` +
        `secret may have been spent at the issuer; do NOT return to wallet without verifying.`,
    );
  },
});

const server = new McpServer({
  name: "x402-webcash-demo",
  version: "0.3.1",
});

server.registerTool(
  "get-premium-data",
  {
    description:
      "Fetch the paywalled /premium endpoint. The MCP server pays the 402 challenge " +
      "transparently using webcash from the configured wallet.",
  },
  async () => {
    try {
      const res = await pay(RESOURCE_URL);
      const text = await res.text();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `${res.status} ${res.statusText}: ${text}` }],
        };
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (err instanceof NoMatchingSecretError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No spendable webcash in ${WALLET_FILE} for this call (need ${err.wats} wats, ` +
                `and no larger secret to split from). Seed the wallet and try again.`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `unexpected error: ${(err as Error)?.message ?? String(err)}` }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());

// stderr is the only safe channel — stdout carries MCP protocol traffic.
// eslint-disable-next-line no-console
console.error(
  `x402-webcash MCP server ready. resource=${RESOURCE_URL} wallet=${WALLET_FILE}`,
);
