function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractReasoningText(item: any): string {
  // Reasoning item shapes vary: {summary: [{text}]}, {content: [{text}]}, {text}
  const parts: string[] = [];
  if (Array.isArray(item?.summary)) {
    for (const s of item.summary) {
      if (typeof s?.text === "string") parts.push(s.text);
    }
  }
  if (Array.isArray(item?.content)) {
    for (const c of item.content) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  if (typeof item?.text === "string") parts.push(item.text);
  return parts.join("\n").trim();
}

/**
 * Translate a non-streaming OpenAI Responses object to an Anthropic
 * Messages response. `model` is the original client-facing model name
 * (preserved so Claude sees consistency).
 */
export function formatResponsesToAnthropic(resp: any, model: string): any {
  const messageId = "msg_" + Date.now();
  const content: any[] = [];

  const output = Array.isArray(resp?.output) ? resp.output : [];

  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part?.text === "string") {
          content.push({ type: "text", text: part.text });
        } else if (part?.type === "refusal" && typeof part?.refusal === "string") {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item?.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    } else if (item?.type === "reasoning") {
      const thinking = extractReasoningText(item);
      if (thinking) content.push({ type: "thinking", thinking, signature: "" });
    }
  }

  // Fallbacks for non-standard shapes (some gateways inline text at top level)
  if (content.length === 0) {
    if (typeof resp?.output_text === "string" && resp.output_text) {
      content.push({ type: "text", text: resp.output_text });
    }
  }

  let stopReason = "end_turn";
  if (content.some((b: any) => b.type === "tool_use")) {
    stopReason = "tool_use";
  } else if (resp?.status === "incomplete") {
    const reason = resp?.incomplete_details?.reason;
    stopReason = reason === "max_output_tokens" ? "max_tokens" : "end_turn";
  }

  const result: any = {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    model,
  };

  if (resp?.usage) {
    result.usage = {
      input_tokens: resp.usage.input_tokens ?? 0,
      output_tokens: resp.usage.output_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
  }

  return result;
}

/** True when a Responses object carries no usable text/reasoning/tool output. */
export function isEmptyResponsesBody(resp: any): boolean {
  const output = resp?.output;
  if (!Array.isArray(output) || output.length === 0) {
    return typeof resp?.output_text !== "string" || !resp.output_text;
  }
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && part?.text) return false;
        if (part?.type === "refusal" && part?.refusal) return false;
      }
    }
    if (item?.type === "function_call") return false;
    if (item?.type === "reasoning" && extractReasoningText(item)) return false;
  }
  return true;
}
