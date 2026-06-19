import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "mimo-v2.5-free";
const DEFAULT_TEXT_MODEL = "deepseek-v4-flash";

const API_START_PATHS = new Set(['v1', 'v2']);

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
        } else {
          req.model = reqHasImages ? VISION_MODEL : DEFAULT_TEXT_MODEL;
        }
        // If user is on /go path with an image request, auto-switch upstream to /zen
        // (vision model is Zen-only). Skip this when user pinned a model — explicit override wins.
        let effectiveUpstream = upstream;
        if (!userPinnedModel && upstream === GO_UPSTREAM && reqHasImages) {
          effectiveUpstream = ZEN_UPSTREAM;
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

  // OpenAI → Anthropic (or pass-through)
  if (route.path === '/v1/chat/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

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
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai)",
      "/v1/chat/completions": "OpenAI → upstream (translated if upstream=anthropic)",
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
