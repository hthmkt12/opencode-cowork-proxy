import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatAnthropicToResponses } from './translate/request/anthropic-to-responses';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { formatResponsesToAnthropic } from './translate/response/responses-to-anthropic';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';
import { streamResponsesToAnthropic } from './translate/stream/responses-to-anthropic';
import { isResponsesModel } from './responses';

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "mimo-v2.6-flash-free";
const DEFAULT_TEXT_MODEL = "deepseek-v4-flash";

const API_START_PATHS = new Set(['v1', 'v2']);

// Claude Desktop's third-party-inference flow sends Anthropic-style placeholder
// model names (e.g. claude-sonnet-4-5-20250514) that have no OpenCode equivalent,
// so the proxy maps them to the smart default (deepseek-v4-flash / mimo-v2.6-flash-free).
// Real clients like Claude Code send the actual model ID (e.g. deepseek-v4-flash-free)
// — those must be honored as-is so users can pick a model directly without URL pinning.
function isAnthropicPlaceholder(model: string): boolean {
  if (!model) return true;
  return model.startsWith("claude-");
}

type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
};

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function extractModelSegment(path: string): { path: string; model: string | null } {
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: '/' + segments.slice(1).join('/'), model: segments[0] };
  }
  return { path, model: null };
}

function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const goPath = stripPrefix(path, "/go");
  if (goPath) {
    const { path: remaining, model } = extractModelSegment(goPath);
    return { path: remaining, upstream: GO_UPSTREAM, modelOverride: model };
  }

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) {
    const { path: remaining, model } = extractModelSegment(zenPath);
    return { path: remaining, upstream: ZEN_UPSTREAM, modelOverride: model };
  }

  const { path: remaining, model } = extractModelSegment(path);
  return { path: remaining, upstream: DEFAULT_UPSTREAM, modelOverride: model };
}

function getUpstream(request: Request, routeUpstream: string): string {
  return request.headers.get("X-Upstream-Url") || routeUpstream;
}

function upstreamFormat(request: Request): "openai" | "anthropic" {
  const fmt = (request.headers.get("X-Upstream-Format") || "openai").toLowerCase();
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function anthropicHeaders(request: Request, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version": request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function hasImages(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image")
  );
}

function isRetriableError(res: Response, body: string): boolean {
  if (res.status === 401 || res.status === 403 || res.status === 400) return false;
  if (res.status >= 500) return true;
  if (res.status === 429) return true;
  if (res.status === 200) {
    try {
      const parsed = JSON.parse(body);
      const content = parsed?.choices?.[0]?.message?.content;
      const reasoning = parsed?.choices?.[0]?.message?.reasoning_content;
      if (!content && !reasoning) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// Rough local token estimate so we can short-circuit Anthropic's
// /v1/messages/count_tokens endpoint without paying for an upstream call.
// Heuristic: ~1 token per 4 chars of text + 85 tokens per image (Anthropic spec).
// This is intentionally a lower-bound estimate — Claude Desktop only uses it
// to show a context-window progress bar, so precision is not critical.
function estimateLocalInputTokens(body: any): number {
  let chars = 0;
  let images = 0;
  const sys = body?.system;
  if (typeof sys === 'string') chars += sys.length;
  else if (Array.isArray(sys)) {
    for (const s of sys) if (typeof s?.text === 'string') chars += s.text.length;
  }
  for (const msg of body?.messages || []) {
    const c = msg?.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && typeof part.text === 'string') chars += part.text.length;
        else if (part?.type === 'image') images++;
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4) + images * 85);
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of ["Content-Type", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const route = routeConfig(request);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);

  // Short-circuit token counting: estimate locally so we don't burn
  // an upstream request every time Claude Desktop refreshes its
  // context-window progress bar. Precision is not critical here —
  // the client only uses this to display a percentage.
  if (route.path === '/v1/messages/count_tokens' && request.method === 'POST') {
    const key = extractApiKey(request.headers);
    const err = validateApiKey(key);
    if (err) return authErrorResponse(err);

    let body: any;
    try { body = await request.json(); } catch { body = {}; }
    const inputTokens = estimateLocalInputTokens(body);
    return new Response(JSON.stringify({ input_tokens: inputTokens }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === '/v1/messages' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      if (fmt === "openai") {
        const req: any = await request.json();
        const originalModel = req.model;
        const userPinnedModel = !!route.modelOverride;
        const reqHasImages = hasImages(req);
        if (route.modelOverride) {
          req.model = route.modelOverride;
        } else if (reqHasImages) {
          req.model = VISION_MODEL;
        } else if (isAnthropicPlaceholder(req.model)) {
          req.model = DEFAULT_TEXT_MODEL;
        }
        // else: honor the real model ID the client sent (e.g. Claude Code
        // configured with deepseek-v4-flash-free directly — no URL pin needed).
        // If user is on /go path with an image request, auto-switch upstream to /zen
        // (vision model is Zen-only). Skip this when user pinned a model — explicit override wins.
        let effectiveUpstream = upstream;
        if (!userPinnedModel && upstream === GO_UPSTREAM && reqHasImages) {
          effectiveUpstream = ZEN_UPSTREAM;
        }
        // Responses-API models (gpt-*, grok-*, muse-spark-*) are Zen-only.
        // Route them to Zen even when the client used the /go prefix.
        if (effectiveUpstream === GO_UPSTREAM && isResponsesModel(req.model)) {
          effectiveUpstream = ZEN_UPSTREAM;
        }

        // Zen models served via OpenAI Responses API (/v1/responses), e.g.
        // muse-spark-1.3-contributor-free, gpt-5.x, grok-4.x.
        if (isResponsesModel(req.model)) {
          const responsesReq = formatAnthropicToResponses(req);
          const res = await fetch(`${effectiveUpstream}/responses`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${key}`,
            },
            body: JSON.stringify(responsesReq),
          });
          if (!res.ok) {
            return upstreamErrorResponse(res, await res.text());
          }
          if (responsesReq.stream) {
            return new Response(streamResponsesToAnthropic(res.body as ReadableStream, originalModel), {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
            });
          }
          let respData: any;
          try {
            respData = await res.json();
          } catch {
            return upstreamErrorResponse(res, await res.clone().text().catch(() => "Invalid upstream JSON"));
          }
          return new Response(JSON.stringify(formatResponsesToAnthropic(respData, originalModel)), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const openaiReq = formatAnthropicToOpenAI(req);
        const primaryModel = openaiReq.model;

        const primaryRes = await fetch(`${effectiveUpstream}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
          },
          body: JSON.stringify(openaiReq),
        });

        let res: Response = primaryRes;
        if (
          !userPinnedModel &&
          primaryModel === DEFAULT_TEXT_MODEL
        ) {
          // Fast-path: 5xx and 429 are always retriable — no need to buffer body
          if (primaryRes.status >= 500 || primaryRes.status === 429) {
            const errorBody = await primaryRes.text();
            const fallbackReq = { ...openaiReq, model: VISION_MODEL };
            const fallbackRes = await fetch(`${ZEN_UPSTREAM}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${key}`,
              },
              body: JSON.stringify(fallbackReq),
            });
            if (fallbackRes.ok) {
              res = fallbackRes;
            } else {
              return upstreamErrorResponse(primaryRes, errorBody);
            }
          } else if (primaryRes.status === 200) {
            // For streaming responses, trust 200 status — probing would buffer
            // the entire SSE stream and kill perceived latency. For non-stream
            // we still probe so an empty/malformed body triggers a retry.
            if (!openaiReq.stream) {
              const probeBody = await primaryRes.clone().text();
              if (isRetriableError(primaryRes, probeBody)) {
                const fallbackReq = { ...openaiReq, model: VISION_MODEL };
                const fallbackRes = await fetch(`${ZEN_UPSTREAM}/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${key}`,
                  },
                  body: JSON.stringify(fallbackReq),
                });
                if (fallbackRes.ok) {
                  res = fallbackRes;
                } else {
                  return upstreamErrorResponse(primaryRes, probeBody);
                }
              }
            }
          } else {
            // 4xx client error — return as-is
            return upstreamErrorResponse(primaryRes, await primaryRes.text());
          }
        } else if (!primaryRes.ok) {
          return upstreamErrorResponse(primaryRes, await primaryRes.text());
        }

        if (openaiReq.stream) {
          return new Response(streamOpenAIToAnthropic(res.body as ReadableStream, originalModel), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toAnthropicResponse(data, originalModel)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to Anthropic upstream
      const res = await fetch(`${upstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: await request.text(),
      });
      return res;
  }

  // OpenAI Responses passthrough (for OpenAI SDK users calling
  // /v1/responses directly with gpt-*/grok-*/muse-spark-* models).
  if (route.path === '/v1/responses' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      let effectiveUpstream = upstream;
      if (effectiveUpstream === GO_UPSTREAM) {
        effectiveUpstream = ZEN_UPSTREAM;
      }
      const res = await fetch(`${effectiveUpstream}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: await request.text(),
      });
      return res;
  }

  // OpenAI → Anthropic (or pass-through)
  if (route.path === '/v1/chat/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      // Responses-API models (muse-spark-*, gpt-*, grok-*) are NOT served
      // via /chat/completions on Zen. Guide callers to the right endpoint
      // instead of proxying to a guaranteed upstream 404.
      if (fmt !== "anthropic") {
        let maybeModel: string | null = route.modelOverride;
        if (!maybeModel) {
          try {
            const raw: any = await request.clone().json();
            maybeModel = typeof raw?.model === "string" ? raw.model : null;
          } catch { maybeModel = null; }
        }
        if (isResponsesModel(maybeModel)) {
          return new Response(JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: `Model '${maybeModel}' is served via the OpenAI Responses API, not /chat/completions. Use POST ${route.modelOverride ? "" : "/v1/responses"} with {"model":"${maybeModel}","input":[...]} — or call the Anthropic path POST /v1/messages with {"model":"${maybeModel}","messages":[...]} and this proxy will translate to /responses for you.`,
            },
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }

      if (fmt === "anthropic") {
        const req = await request.json();
        const anthReq = formatOpenAIToAnthropic(req);
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: JSON.stringify(anthReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (anthReq.stream) {
          return new Response(streamAnthropicToOpenAI(res.body as ReadableStream, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toOpenAIResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to OpenAI upstream
      const res = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: await request.text(),
      });
      return res;
  }

  // Model discovery
  if (route.path === '/v1/models' && request.method === 'GET') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${key}` },
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    name: "opencode-cowork-proxy",
    upstream,
    routes: {
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
    },
    endpoints: {
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai; responses models go to /responses)",
      "/v1/chat/completions": "OpenAI → upstream (translated if upstream=anthropic)",
      "/v1/responses": "OpenAI Responses passthrough (gpt-*/grok-*/muse-spark-*)",
      "/v1/models": "Model discovery proxy",
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: route.path === '/' ? 200 : 404,
  });
}

const app = new Hono();
app.all('*', (c) => handleRequest(c.req.raw));

export default app;
