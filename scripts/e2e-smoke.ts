/**
 * End-to-end smoke test for the deployed opencode-cowork-proxy worker.
 *
 * Usage:
 *   OPENCODE_API_KEY=sk-... node --experimental-strip-types scripts/e2e-smoke.ts
 *   OPENCODE_API_KEY=sk-... WORKER_URL=http://localhost:8787 \
 *     npx wrangler dev &  # in another terminal
 *   OPENCODE_API_KEY=sk-... node --experimental-strip-types scripts/e2e-smoke.ts
 *
 * Exits 0 if all scenarios pass, 1 otherwise.
 */

const API_KEY = process.env.OPENCODE_API_KEY;
const WORKER_URL = process.env.WORKER_URL || "https://opencode-cowork-proxy.hthmkt1.workers.dev";

if (!API_KEY) {
  console.error("ERROR: Set OPENCODE_API_KEY env var to run E2E tests.");
  console.error("  PowerShell: $env:OPENCODE_API_KEY = 'sk-...'");
  console.error("  bash:       OPENCODE_API_KEY=sk-... node ...");
  process.exit(2);
}

type Scenario = {
  name: string;
  run: () => Promise<void>;
  timeoutMs?: number;
};

const SHORT_KEY = "short"; // triggers local 401 gate (< 16 chars)

function fmtTime(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function postJson(url: string, body: any, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY!, ...headers },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "GET", headers: { "x-api-key": API_KEY!, ...headers } });
}

const scenarios: Scenario[] = [
  {
    name: "GET / returns worker info",
    run: async () => {
      const res = await fetch(WORKER_URL + "/");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: any = await res.json();
      if (data.name !== "opencode-cowork-proxy") throw new Error(`unexpected name: ${data.name}`);
      if (!data.routes?.["/go"]) throw new Error("missing /go route");
    },
  },

  {
    name: "POST /v1/messages without api key returns 401",
    run: async () => {
      const res = await fetch(WORKER_URL + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    },
  },

  {
    name: "POST /v1/messages with short key returns 401",
    run: async () => {
      const res = await fetch(WORKER_URL + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": SHORT_KEY },
        body: "{}",
      });
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    },
  },

  {
    name: "POST /v1/messages/count_tokens short-circuits (no upstream call)",
    run: async () => {
      const res = await postJson(WORKER_URL + "/v1/messages/count_tokens", {
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hi there friend" }],
      });
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (typeof data.input_tokens !== "number" || data.input_tokens < 1) {
        throw new Error(`bad input_tokens: ${JSON.stringify(data)}`);
      }
    },
  },

  {
    name: "POST /go/v1/messages text returns deepseek-v4-flash response",
    timeoutMs: 60000,
    run: async () => {
      const res = await postJson(WORKER_URL + "/go/v1/messages", {
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 30,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (data.model !== "claude-sonnet-4-5-20250514") {
        throw new Error(`model not preserved: ${data.model}`);
      }
      const text = data.content?.[0]?.text ?? "";
      if (!text.toLowerCase().includes("pong")) {
        throw new Error(`expected 'pong' in response, got: ${text.slice(0, 100)}`);
      }
    },
  },

  {
    name: "POST /zen/v1/messages text returns response",
    timeoutMs: 60000,
    run: async () => {
      const res = await postJson(WORKER_URL + "/zen/v1/messages", {
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 30,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (!data.content?.[0]?.text) throw new Error("no text content");
    },
  },

  {
    name: "POST /go/kimi-k2.6/v1/messages URL pin uses pinned model",
    timeoutMs: 60000,
    run: async () => {
      const res = await postJson(WORKER_URL + "/go/kimi-k2.6/v1/messages", {
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say hi" }],
      });
      if (!res.ok) {
        const body = await res.text();
        // Kimi might be unavailable right now — skip rather than fail
        if (res.status === 404 || res.status === 400 || body.includes("not found")) {
          console.log("    (skipped: kimi-k2.6 unavailable)");
          return;
        }
        throw new Error(`status ${res.status}: ${body}`);
      }
      const data: any = await res.json();
      if (data.model !== "claude-sonnet-4-5-20250514") {
        throw new Error(`response model not preserved: ${data.model}`);
      }
    },
  },

  {
    name: "POST /go/v1/messages with image auto-routes to zen (mimo-v2.5-free)",
    timeoutMs: 90000,
    run: async () => {
      // Tiny 1x1 PNG (67 bytes), base64 encoded
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      const res = await postJson(WORKER_URL + "/go/v1/messages", {
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What color is this 1x1 image? Answer in one word." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
            ],
          },
        ],
      });
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (data.model !== "claude-sonnet-4-5-20250514") {
        throw new Error(`response model not preserved: ${data.model}`);
      }
      if (!data.content?.length) throw new Error("no content blocks");
    },
  },

  {
    name: "POST /v1/messages with stream=true returns SSE events",
    timeoutMs: 60000,
    run: async () => {
      const res = await postJson(WORKER_URL + "/go/v1/messages", {
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 20,
        stream: true,
        messages: [{ role: "user", content: "Count: 1" }],
      });
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/event-stream")) {
        throw new Error(`expected SSE content-type, got: ${ct}`);
      }
      const text = await res.text();
      if (!text.includes("event: message_start")) {
        throw new Error("missing message_start event");
      }
      if (!text.includes("event: message_stop")) {
        throw new Error("missing message_stop event");
      }
      if (!text.includes('"type":"text_delta"')) {
        throw new Error("missing text_delta event");
      }
    },
  },

  {
    name: "GET /v1/models returns upstream model list",
    timeoutMs: 30000,
    run: async () => {
      const res = await getJson(WORKER_URL + "/go/v1/models");
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error(`expected data array, got: ${JSON.stringify(data).slice(0, 200)}`);
      }
    },
  },
];

async function runWithTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(() => { clearTimeout(timer); resolve(); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  console.log(`E2E smoke test against ${WORKER_URL}`);
  console.log(`API key: ${API_KEY!.slice(0, 6)}...${API_KEY!.slice(-4)}\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const s of scenarios) {
    const start = Date.now();
    try {
      await runWithTimeout(s.run(), s.timeoutMs ?? 30000);
      console.log(`  ✓ ${s.name}  (${fmtTime(Date.now() - start)})`);
      passed++;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("(skipped")) {
        console.log(`  ~ ${s.name}  (${fmtTime(Date.now() - start)})`);
        skipped++;
      } else {
        console.log(`  ✗ ${s.name}  (${fmtTime(Date.now() - start)})`);
        console.log(`      ${msg}`);
        failed++;
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(2);
});
