/**
 * Translate an Anthropic Messages request body to an OpenAI Responses
 * request body (`POST /v1/responses`).
 *
 * Used for Zen models served via /responses: gpt-*, grok-*,
 * muse-spark-* (incl. muse-spark-1.3-contributor-free).
 */

function translateImagePart(part: any): any | null {
  const src = part.source;
  if (!src) return null;
  if (src.type === "url" && src.url) {
    return { type: "input_image", image_url: src.url };
  }
  if (src.type === "base64" && src.data) {
    const media = src.media_type || "image/png";
    return { type: "input_image", image_url: `data:${media};base64,${src.data}` };
  }
  return null;
}

function toolContentToString(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === "string" ? p.text : JSON.stringify(p)))
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

export function formatAnthropicToResponses(body: any): any {
  const { model, messages, system, temperature, max_tokens, top_p, tools, stream } = body;

  const input: any[] = [];

  if (typeof system === "string" && system) {
    input.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((s: any) => (typeof s?.text === "string" ? s.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) input.push({ role: "system", content: text });
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        if (msg.role === "user" || msg.role === "assistant") {
          input.push({ role: msg.role, content: msg.content });
        }
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      if (msg.role === "user") {
        const contentParts: any[] = [];
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string") {
            contentParts.push({ type: "input_text", text: part.text });
          } else if (part.type === "image") {
            const img = translateImagePart(part);
            if (img) contentParts.push(img);
          } else if (part.type === "tool_result") {
            input.push({
              type: "function_call_output",
              call_id: part.tool_use_id,
              output: toolContentToString(part.content),
            });
          }
        }
        if (contentParts.length > 0) {
          input.push({ role: "user", content: contentParts });
        }
      } else if (msg.role === "assistant") {
        let text = "";
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string") {
            text += part.text + "\n";
          } else if (part.type === "tool_use") {
            input.push({
              type: "function_call",
              call_id: part.id,
              name: part.name,
              arguments: JSON.stringify(part.input ?? {}),
            });
          }
          // NOTE: thinking blocks are intentionally dropped from history —
          // Responses reasoning items require encrypted content for
          // multi-turn continuity, which we don't have.
        }
        const trimmed = text.trim();
        if (trimmed) input.push({ role: "assistant", content: trimmed });
      }
    }
  }

  const data: any = { model, input };

  if (max_tokens !== undefined) data.max_output_tokens = max_tokens;
  if (temperature !== undefined) data.temperature = temperature;
  if (top_p !== undefined) data.top_p = top_p;
  if (stream !== undefined) data.stream = stream;

  if (Array.isArray(tools)) {
    data.tools = tools.map((item: any) => ({
      type: "function",
      name: item.name,
      description: item.description,
      parameters: item.input_schema,
    }));
  }

  return data;
}
