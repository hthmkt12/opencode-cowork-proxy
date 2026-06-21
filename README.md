# OpenCode Cowork Proxy Worker

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cucoleadan/opencode-cowork-proxy)

This project lets Claude use OpenCode Go models, and some OpenCode Zen models.

Claude normally speaks the Anthropic API format. OpenCode Go mostly speaks OpenAI-compatible API format. This small Cloudflare Worker sits in the middle and translates between them.

I covered how to set this up in Claude in [How to Use Claude Code for Free with OpenCode](https://vibestacklab.substack.com/p/how-to-use-claude-code-for-free-with).

### Image / Vision Support

When you attach an image in Claude Code and send it through this proxy, the request is automatically routed to **MiMo-V2.5 Free** (`mimo-v2.5-free`) — a free vision-capable model available on OpenCode Zen. The proxy detects image blocks in your request, translates them to OpenAI's image format, and overrides the model to MiMo-V2.5 Free so the model can actually see the image.

**Hybrid routing**: when your base URL uses the `/go` prefix, the proxy stays on Go for text requests (`deepseek-v4-flash` on `https://opencode.ai/zen/go/v1`) but **auto-switches the upstream to Zen** for image requests, because `mimo-v2.5-free` is Zen-only. Pinning a model in the URL (e.g. `/go/deepseek-v4-flash`) keeps the request on Go even with images.

No configuration needed — it just works as long as you have an OpenCode Go or Zen subscription.

### Default Text Model

Text-only requests (no images) are routed to **DeepSeek V4 Flash** (`deepseek-v4-flash`) by default — a fast, cheap chat model on both OpenCode Go and Zen. If `deepseek-v4-flash` returns a retriable failure (5xx, 429, or an empty/malformed body), the proxy automatically falls back to the vision model **on Zen** so you don't get stuck on transient errors. Pin a model in the URL (e.g. `/go/kimi-k2.6`) to opt out of the auto-default and the fallback.

## Free Models

We support a pay-as-you-go model. Below are the prices per 1M tokens for completely free models available through OpenCode Zen.

| Model | Model ID | Input | Output | Cached Read |
|-------|----------|-------|--------|-------------|
| Big Pickle | `big-pickle` | Free | Free | Free |
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | Free | Free | Free |
| MiMo-V2.5 Free | `mimo-v2.5-free` | Free | Free | Free |
| Nemotron 3 Super Free | `nemotron-3-super-free` | Free | Free | Free |

These models are available at `https://opencode.ai/zen/v1/chat/completions` via the `/zen` prefix. For the full model list and latest pricing, see the [OpenCode Zen endpoint docs](https://opencode.ai/docs/zen/#endpoints).

## Set Up In Claude

The proxy now defaults text requests to **`deepseek-v4-flash`** and image requests to **`mimo-v2.5-free`**. The recommended base URL is `/go`: text runs on Go (`https://opencode.ai/zen/go/v1`), and image requests auto-switch to Zen so the vision model is reachable. If you want to pin a different model, use the URL-override trick described in [Model Name Override](#model-name-override).

1. Deploy this Worker to Cloudflare.
2. Copy your deployed Worker URL.
3. In Claude, open **Configure third-party Inference**.
4. Choose the gateway / third-party inference option.
5. Set the base URL to `YOUR_DEPLOYED_WORKER_URL/go`.
6. Set the auth scheme to `x-api-key`.
7. Paste your OpenCode API key.
8. Add `deepseek-v4-flash` as the model name (the proxy will route this to the text model — pin a different ID in the URL to override).

Important: do not add `/v1/messages` to the URL. Claude adds that path automatically.

## Quick Claude Configuration

Use these values in Claude's **Configure third-party Inference** screen:

| Setting | Value |
|---------|-------|
| Provider | Gateway / third-party inference gateway |
| Base URL | `YOUR_DEPLOYED_WORKER_URL/go` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode API key |
| Models | Add manually, for example `deepseek-v4-flash` (text) or `mimo-v2.5-free` (vision) |

For the default example above, use `/go` so the default text model runs on Go. Image requests auto-switch to Zen under the hood. Use `/zen` instead if you want both text and image to stay on Zen. Do not add `/v1/messages` yourself. Claude adds the API path automatically.

To pin a different model without the smart-routing defaults, append the model ID after the prefix: `YOUR_DEPLOYED_WORKER_URL/go/kimi-k2.6` uses `kimi-k2.6` on Go directly and skips the default + auto-route + fallback. See [Model Name Override](#model-name-override) for the full behavior matrix.

## What This Does

The Worker accepts Claude's Anthropic-style requests at `/v1/messages`, converts them to OpenAI-style requests, and sends them to OpenCode Go by default.

You can choose an OpenCode upstream by adding a prefix to the Worker URL:

| Worker URL suffix | Upstream |
|-------------------|----------|
| no suffix | OpenCode Go |
| `/go` | OpenCode Go |
| `/zen` | OpenCode Zen |

For example, use `YOUR_DEPLOYED_WORKER_URL/go` for Go models and `YOUR_DEPLOYED_WORKER_URL/zen` for Zen models.

It also handles tool calls, streaming, and DeepSeek reasoning output so coding-agent workflows work correctly.

Important: this proxy has been live-tested with `deepseek-v4-flash` (default text) and `mimo-v2.5-free` (default vision) on the Zen path. Other OpenCode Go models are included from the public OpenCode Go model list, but provider behavior can vary, especially around streaming usage/token accounting.

## Important Zen Limitation

OpenCode Zen support is partial.

This proxy currently works with Zen models that use the OpenAI-compatible `/chat/completions` endpoint.

Known Zen model categories that should work through `/zen`:

| Zen model category | Examples |
|--------------------|----------|
| OpenAI-compatible chat models | `minimax-m2.7`, `minimax-m2.5`, `mimo-v2.5-free`, `glm-5.1`, `glm-5`, `kimi-k2.5`, `kimi-k2.6`, `grok-build-0.1`, `big-pickle`, `deepseek-v4-flash`, `deepseek-v4-flash-free`, `nemotron-3-super-free` |

Known Zen model categories that do not work yet through this proxy:

| Zen model category | Why it does not work yet |
|--------------------|--------------------------|
| GPT models such as `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.3-codex`, `gpt-5.2` | Zen exposes these through `/responses`, and this proxy does not yet translate Anthropic Messages to OpenAI Responses API. |
| Claude models such as `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | Zen exposes these through `/messages`; this proxy's `/zen` Claude path currently translates to OpenAI-compatible `/chat/completions`. |
| Qwen models such as `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus` | Zen exposes these through `/messages` (Anthropic-compatible), not `/chat/completions`. |
| Gemini models such as `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-3-flash` | Zen exposes these through model-specific endpoints, not the generic chat-completions path used here. |

Use `/go` for OpenCode Go. Use `/zen` only for Zen models listed as OpenAI-compatible chat models in the [OpenCode Zen endpoint docs](https://opencode.ai/docs/zen/#endpoints).

## For Developers (OpenCode Cowork Proxy Worker)

Technically, this is a Cloudflare Worker gateway that lets Anthropic/Claude clients talk to OpenAI-compatible APIs, and lets OpenAI clients talk to Anthropic-compatible APIs.

The default upstream is [OpenCode Go](https://opencode.ai/docs/go/#endpoints):

```text
https://opencode.ai/zen/go/v1
```

This means Claude can be configured to use OpenCode Go models through this proxy without additional server-side configuration.

```text
Claude / Anthropic SDK  ->  /v1/messages           ->  OpenAI-compatible upstream
OpenAI SDK              ->  /v1/chat/completions   ->  OpenAI-compatible upstream
OpenAI SDK              ->  /v1/chat/completions   ->  Anthropic upstream with x-upstream-format: anthropic
```

## Detailed Claude Setup

Use Claude's **Configure third-party Inference** flow and add the Worker as a custom gateway.

Configure the gateway like this:

| Setting | Value |
|---------|-------|
| Base URL | Your deployed Worker URL, or add `/go` or `/zen` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode Go API key |
| Model | Add manually, for example `deepseek-v4-pro` |

Do not include `/v1/messages` in the Claude base URL. Claude will call `/v1/messages`; the Worker handles that path.

Use `/go` for OpenCode Go subscription models. Use `/zen` only for OpenCode Zen models available through the OpenAI-compatible `/chat/completions` endpoint. Zen GPT `/responses`, Zen Claude `/messages`, and Zen Gemini model-specific endpoints are not supported yet.

### Manual Model Setup

Claude may not discover the OpenCode Go models automatically. Add the model manually in **Configure third-party Inference**.

Common OpenCode Go model IDs:

| Model | Model ID | Upstream API style |
|-------|----------|--------------------|
| GLM-5.1 | `glm-5.1` | OpenAI-compatible |
| GLM-5 | `glm-5` | OpenAI-compatible |
| Kimi K2.5 | `kimi-k2.5` | OpenAI-compatible |
| Kimi K2.6 | `kimi-k2.6` | OpenAI-compatible |
| DeepSeek V4 Pro | `deepseek-v4-pro` | OpenAI-compatible |
| DeepSeek V4 Flash | `deepseek-v4-flash` | OpenAI-compatible |
| MiMo-V2.5-Pro | `mimo-v2.5-pro` | OpenAI-compatible |
| MiMo-V2.5 | `mimo-v2.5` | OpenAI-compatible |
| MiniMax M3 | `minimax-m3` | Anthropic-compatible upstream |
| MiniMax M2.7 | `minimax-m2.7` | Anthropic-compatible upstream |
| MiniMax M2.5 | `minimax-m2.5` | Anthropic-compatible upstream |
| Qwen3.7 Max | `qwen3.7-max` | Anthropic-compatible upstream |
| Qwen3.6 Plus | `qwen3.6-plus` | Anthropic-compatible upstream |

For the latest list, see the OpenCode Go endpoint docs:

```text
https://opencode.ai/docs/go/#endpoints
```

For OpenCode's own config files, model IDs use the `opencode-go/<model-id>` format. For Claude's third-party inference setup through this proxy, use the raw API model ID such as `deepseek-v4-pro`, `kimi-k2.6`, or `minimax-m3`.

### `claude.json` Example

You can also configure Claude with a `claude.json` gateway entry. Replace the Worker URL and API key with your own values.

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "YOUR_DEPLOYED_WORKER_URL/go",
  "inferenceGatewayApiKey": "YOUR_OPENCODE_GO_API_KEY",
  "inferenceGatewayAuthScheme": "x-api-key",
  "inferenceModels": [
    {
      "name": "glm-5.1"
    },
    {
      "name": "glm-5"
    },
    {
      "name": "kimi-k2.5"
    },
    {
      "name": "kimi-k2.6"
    },
    {
      "name": "deepseek-v4-pro"
    },
    {
      "name": "deepseek-v4-flash"
    },
    {
      "name": "mimo-v2.5-pro"
    },
    {
      "name": "mimo-v2.5"
    },
    {
      "name": "minimax-m3"
    },
    {
      "name": "minimax-m2.7"
    },
    {
      "name": "minimax-m2.5"
    },
    {
      "name": "qwen3.7-max"
    },
    {
      "name": "qwen3.6-plus"
    }
  ]
}
```

## Deploy On Cloudflare

This project is intended to run as a Cloudflare Worker. Deploy it to Cloudflare using either the deploy button above or Cloudflare's Git-based Worker deployment flow.

Use these settings when connecting the repository in Cloudflare:

| Setting | Value |
|---------|-------|
| Build command | empty |
| Deploy command | `npm run deploy` |
| Production branch | `main` |

Do not deploy this as a normal Node.js web app. `wrangler deploy` builds and publishes the Worker from `wrangler.toml`.

## Configuration

The Worker is zero-config by default. It forwards to OpenCode Go using OpenAI-compatible format. You can also route to OpenCode Zen by adding `/zen` to the Worker URL.

Optional request headers:

| Header | Default | Description |
|--------|---------|-------------|
| `x-upstream-url` | `https://opencode.ai/zen/go/v1` | Upstream API base URL |
| `x-upstream-format` | `openai` | Upstream format: `openai` or `anthropic` |
| `x-api-key` | required | Upstream API key |
| `authorization` | optional | `Bearer <key>` also works |
| `anthropic-version` | `2023-06-01` | Forwarded when calling Anthropic-compatible upstreams |
| `anthropic-beta` | unset | Forwarded when calling Anthropic-compatible upstreams |

The API key is validated locally before any upstream call. Missing or short keys receive a 401 response.

Prefix routes:

| Path prefix | Upstream base URL |
|-------------|-------------------|
| `/go` | `https://opencode.ai/zen/go/v1` |
| `/zen` | `https://opencode.ai/zen/v1` |

### Model Name Override

Claude Desktop may reject model names that don't look like Anthropic models (e.g. `claude-sonnet-4-5` or `anthropic/claude-*`). To work around this, embed the real model name in the URL path after the prefix:

```
YOUR_DEPLOYED_WORKER_URL/zen/mimo-v2.5-free   # free Zen models
YOUR_DEPLOYED_WORKER_URL/go/deepseek-v4-pro   # paid Go models
YOUR_DEPLOYED_WORKER_URL/go/kimi-k2.6         # paid Go models, skip all smart routing
```

Claude appends `/v1/messages`, so the full request becomes `YOUR_WORKER_URL/zen/mimo-v2.5-free/v1/messages`. The proxy extracts the model from the path and uses it regardless of what Claude sends in the request body.

**What URL pinning skips** (use it when you want full control):

| Behavior | Without URL pin | With URL pin (`/go/kimi-k2.6`) |
|----------|-----------------|-------------------------------|
| Default text model | Forced to `deepseek-v4-flash` | Uses the pinned model |
| Image → Zen auto-route | `/go` image requests auto-switch to Zen upstream | Stays on `/go` even with images |
| Fallback on failure | Tries `mimo-v2.5-free` on Zen if `deepseek-v4-flash` fails | Returns the original error to the client |

**Usage:**
1. Configure Claude with any Anthropic-looking model name (e.g. `claude-sonnet-4-5-20250514`) — this passes Claude's client-side validation.
2. Set the base URL to `YOUR_WORKER_URL/zen/REAL_MODEL_ID` (replace `REAL_MODEL_ID` with the actual OpenCode model).
3. The proxy silently maps the model for the upstream request.
4. The response uses the original model name you configured, so Claude sees consistency.

| Setting | Value |
|---------|-------|
| Base URL | `YOUR_WORKER_URL/zen/mimo-v2.5-free` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode API key |
| Model | `claude-sonnet-4-5-20250514` (any Anthropic-looking name) |

This works with all Go and Zen models.

## API Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/v1/messages` | POST | Anthropic Messages API. Translates to OpenAI format by default. |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API. Pass-through by default. |
| `/v1/models` | GET | Model discovery proxy. |

## OpenAI SDK Usage

Point any OpenAI-compatible client at the gateway. By default, `/v1/chat/completions` passes through to OpenCode Go.

```python
from openai import OpenAI

client = OpenAI(
    base_url="YOUR_DEPLOYED_WORKER_URL/v1",
    api_key="your-opencode-go-api-key",
)

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## OpenAI SDK To Anthropic

Set `x-upstream-format: anthropic` and point `x-upstream-url` at an Anthropic-compatible API.

```bash
curl YOUR_DEPLOYED_WORKER_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_ANTHROPIC_KEY" \
  -H "x-upstream-url: https://api.anthropic.com" \
  -H "x-upstream-format: anthropic" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}]}'
```

## Translation Notes

The gateway handles:

- Anthropic Messages requests to OpenAI Chat Completions requests
- OpenAI Chat Completions responses to Anthropic Messages responses
- Tool calls and tool results in both directions
- Streaming SSE in both directions
- DeepSeek/OpenAI `reasoning_content` as Anthropic `thinking` blocks
- Prompt cache key injection for OpenAI-style prefix caching

## Prompt Caching

When translating Anthropic to OpenAI, the gateway injects a `prompt_cache_key` derived from a hash of the system prompt. This keeps requests with the same system prompt routed to the same backend node when the upstream supports OpenAI-style prefix caching.

Cache hit tokens from OpenAI-compatible usage metadata are mapped back to Anthropic's `cache_read_input_tokens` field.

## Troubleshooting

### `401 Invalid API key` (local gate)

```
{"error":{"type":"authentication_error","message":"Invalid API key: must be at least 32 characters."}}
```

**Cause**: The proxy validates the API key locally before any upstream call. It must be at least 32 characters and present in `x-api-key` or `Authorization: Bearer <key>`.

**Fix**:
- Check the key is in the right header: `x-api-key`, not `Authorization` without `Bearer`.
- Get a fresh key from <https://opencode.ai/auth> if the current one is shorter than 32 chars.
- Test directly: `curl -H "x-api-key: <KEY>" https://YOUR_WORKER/zen/v1/models`.

### `401 CreditsError` from Zen path

```
{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance."}}
```

**Cause**: `/zen` and `/go` use different billing on OpenCode. Go credits don't transfer to Zen. The free models on Zen (e.g. `mimo-v2.5-free`) have a separate rate limit; all other Zen models need paid credits.

**Fix**:
- Add Zen credits at <https://opencode.ai/workspace> → Billing.
- For free usage only, stay on `/go` and pin models like `kimi-k2.6` or `deepseek-v4-flash` (Go tier).
- For image requests, the proxy auto-routes `/go` image requests to `/zen` for `mimo-v2.5-free`; if Zen is exhausted those will fail with 429 instead.

### `429 FreeUsageLimitError` on free models

```
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}
```

**Cause**: OpenCode's free models (`mimo-v2.5-free`, `deepseek-v4-flash-free`, `big-pickle`, `north-mini-code-free`, `nemotron-3-ultra-free`) reset on a per-account basis. `mimo-v2.5-free` is the only vision-capable free model and is shared across all free users.

**Fix**:
- Wait for the rate limit to reset (usually minutes to an hour).
- Pin a paid model in the URL: `https://YOUR_WORKER/go/kimi-k2.6` skips `mimo-v2.5-free` for vision.
- Subscribe to Zen credits for guaranteed availability.

### Empty response: only `thinking` block, no `text`

```json
{
  "content": [{"type": "thinking", "thinking": "..."}],
  "stop_reason": "max_tokens"
}
```

**Cause**: Reasoning-capable models (`deepseek-v4-flash`, `kimi-k2.6`, `minimax-m3`) emit long `reasoning_content` blocks before the final answer. If `max_tokens` is too small, the model exhausts the budget during thinking and never reaches the actual text.

**Fix**:
- Increase `max_tokens` in your request. Start with 500–1000 for reasoning models.
- If you're using Claude Desktop, set the max output tokens in **Settings → Model**.
- If you want a non-reasoning default, pin a model in the URL: `/go/kimi-k2.6` is faster for short tasks.

### Streaming hangs or first byte is slow

**Cause**: Cloudflare Workers can have a cold start on the first request after deploy (1-3 seconds). Subsequent requests are fast.

**Fix**:
- Warm up the worker with a low-stakes request after deploy.
- The proxy supports streaming for all `/v1/messages` requests; if streaming is broken on the client, check that `stream: true` is in the request body.

### `count_tokens` returns wrong estimate

**Cause**: The proxy short-circuits `/v1/messages/count_tokens` with a local heuristic (chars/4 + 85 per image). It's a lower bound on purpose — Claude Desktop only uses this to display a context-window progress bar, not for billing.

**Fix**:
- If you need exact token counts, call the upstream API directly.
- The estimate is intentionally conservative so the progress bar doesn't jump past actual usage.

### Image request fails on `/go`

**Cause**: The proxy auto-routes `/go` image requests to the `/zen` upstream (since `mimo-v2.5-free` is Zen-only). If Zen has no credits or the free model is rate-limited, the image will fail.

**Fix**:
- Use `/zen` URL directly if you have Zen credits.
- Pin a vision-capable model in the URL: `/go/qwen3.6-plus` stays on Go and uses a vision model (note: requires Go tier support for qwen3.6-plus — check the [Go model list](https://opencode.ai/docs/go/#endpoints)).
- Wait for the free vision model rate limit to reset.

### `404` or model not found after URL pin

**Cause**: The model ID in the URL path is unknown to the upstream, or it's only available on one of `/go` / `/zen`.

**Fix**:
- Check the model exists in the relevant list:
  - [Go models](https://opencode.ai/docs/go/#endpoints)
  - [Zen models](https://opencode.ai/docs/zen/#endpoints)
- Some models (e.g. `gpt-5.5`, `claude-opus-4-8`) use non-`/chat/completions` endpoints and aren't supported by this proxy yet.

### Request times out after 30s

**Cause**: Cloudflare Workers have a 30-second CPU time limit on the free plan and a 30-second wall time on paid plans for streaming responses.

**Fix**:
- Reduce `max_tokens` for the task.
- Switch to a faster, non-reasoning model: `/go/kimi-k2.6` or `/zen/glm-5`.
- For long tasks, the worker can be deployed on a paid plan with extended limits.

### `503` Worker exceeded resource limits (Error 1102)

```
Error 1102: Worker exceeded resource limits (CPU time or memory) and was terminated.
```

**Cause**: Cloudflare Workers on the Free plan have a **10ms CPU time** limit per request. Long reasoning streams (e.g. `deepseek-v4-flash`, `kimi-k2.6`) emit thousands of small SSE deltas per second; each `enqueue` + `JSON.stringify` costs CPU and adds up fast. The proxy now batches consecutive same-type deltas into 1KB chunks to stay under the limit, but extreme requests (e.g. very long thinking with 10K+ tokens) can still exceed it.

**Fix**:
- This proxy already batches deltas (see `src/translate/stream/openai-to-anthropic.ts` and `anthropic-to-openai.ts`) — make sure you're running a deployed version newer than commit `e4303d1` / `a36ec80`.
- Reduce `max_tokens` for very long reasoning tasks. Reasoning models use budget on the `thinking` block first; with low `max_tokens` the model exhausts it during thinking and never reaches the answer (see "Empty response: only `thinking` block" above).
- Switch to a non-reasoning model for short tasks: `/go/kimi-k2.6` (Go tier) or `/zen/glm-5` (Zen tier).
- For persistent 1102 errors on Free plan, upgrade to Workers Paid ($5/mo) — raises the CPU limit to 30s.
- The same request always hits the same limit, so retrying won't help.

## Development

```bash
npm install
npm test               # unit tests (no API key required)
npm run e2e            # E2E smoke test against deployed worker (requires OPENCODE_API_KEY)
npm run deploy -- --dry-run
```

Project structure:

```text
src/
├── index.ts                          Main Worker router and auth gate
├── auth.ts                           API key extraction and validation
├── cache.ts                          Prompt cache key utilities
└── translate/
    ├── request/                      Request translators
    ├── response/                     Response translators
    └── stream/                       SSE stream translators
test/
├── auth.test.ts
├── cache.test.ts
├── index.test.ts
├── request.test.ts
├── response.test.ts
└── stream.test.ts
```

## License

MIT. See [LICENSE](LICENSE).
