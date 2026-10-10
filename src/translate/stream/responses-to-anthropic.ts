const encoder = new TextEncoder();

// Same batching rationale as the chat-completions streamer: Responses
// reasoning/text deltas can arrive in hundreds of tiny SSE events and
// each enqueue costs CPU against the 10ms Free-plan limit.
const DELTA_FLUSH_BYTES = 1024;

/**
 * Translate an OpenAI Responses SSE stream (`POST /v1/responses` with
 * `stream:true`) to Anthropic Messages SSE.
 *
 * Upstream event types handled (OpenAI Responses streaming):
 * - response.output_text.delta {delta}
 * - response.reasoning_summary_text.delta / response.reasoning_text.delta {delta}
 * - response.output_item.added {item:{type:function_call,call_id,name}}
 * - response.function_call_arguments.delta {delta}
 * - response.function_call_arguments.done {arguments,name,call_id}
 * - response.completed {response:{output,usage,status}}
 * - response.failed / response.incomplete (terminates with usage when present)
 * - error {message}
 */
export function streamResponsesToAnthropic(responsesStream: ReadableStream, model: string): ReadableStream {
  const messageId = "msg_" + Date.now();

  const messageStartEvent = encoder.encode(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`
  );

  const enqueueSSE = (controller: ReadableStreamDefaultController, eventType: string, data: any) => {
    controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const buildThinkingDelta = (index: number, thinking: string): Uint8Array =>
    encoder.encode(
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(thinking)}}}\n\n`
    );
  const buildTextDelta = (index: number, text: string): Uint8Array =>
    encoder.encode(
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`
    );

  return new ReadableStream({
    async start(controller) {
      let contentBlockIndex = -1;
      let hasStartedTextBlock = false;
      let hasStartedThinkingBlock = false;
      let isToolUse = false;
      let currentToolCallId: string | null = null;
      let messageStarted = false;
      let lastUsage: any = null;
      let sawFunctionCall = false;
      let terminated = false;

      // output_index -> {call_id, name} for function calls announced via
      // response.output_item.added before their argument deltas arrive.
      const toolByIndex = new Map<number, { call_id: string; name: string }>();

      let pendingThinking: { index: number; text: string } | null = null;
      let pendingText: { index: number; text: string } | null = null;

      const flushPendingThinking = () => {
        if (pendingThinking) {
          controller.enqueue(buildThinkingDelta(pendingThinking.index, pendingThinking.text));
          pendingThinking = null;
        }
      };
      const flushPendingText = () => {
        if (pendingText) {
          controller.enqueue(buildTextDelta(pendingText.index, pendingText.text));
          pendingText = null;
        }
      };
      const flushPending = () => { flushPendingThinking(); flushPendingText(); };

      const ensureMessageStarted = () => {
        if (!messageStarted) {
          controller.enqueue(messageStartEvent);
          messageStarted = true;
        }
      };

      const stopCurrentBlock = () => {
        if (isToolUse || hasStartedTextBlock || hasStartedThinkingBlock) {
          enqueueSSE(controller, "content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          });
        }
        isToolUse = false;
        hasStartedTextBlock = false;
        hasStartedThinkingBlock = false;
        currentToolCallId = null;
        contentBlockIndex++;
      };

      const startTextBlock = () => {
        if (pendingThinking) flushPendingThinking();
        if (isToolUse || hasStartedThinkingBlock) stopCurrentBlock();
        if (!hasStartedTextBlock) {
          if (contentBlockIndex < 0) contentBlockIndex = 0;
          ensureMessageStarted();
          enqueueSSE(controller, "content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          });
          hasStartedTextBlock = true;
        }
      };

      const startThinkingBlock = () => {
        if (pendingText) flushPendingText();
        if (isToolUse || hasStartedTextBlock) stopCurrentBlock();
        if (!hasStartedThinkingBlock) {
          if (contentBlockIndex < 0) contentBlockIndex = 0;
          ensureMessageStarted();
          enqueueSSE(controller, "content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
          hasStartedThinkingBlock = true;
        }
      };

      const startToolBlock = (callId: string, name: string | undefined) => {
        flushPending();
        if (isToolUse || hasStartedTextBlock || hasStartedThinkingBlock) {
          enqueueSSE(controller, "content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          });
        }
        isToolUse = true;
        hasStartedTextBlock = false;
        hasStartedThinkingBlock = false;
        currentToolCallId = callId;
        contentBlockIndex++;
        sawFunctionCall = true;
        ensureMessageStarted();
        enqueueSSE(controller, "content_block_start", {
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "tool_use", id: callId, name, input: {} },
        });
      };

      function handleEvent(ev: any) {
        if (!ev || typeof ev.type !== "string") return;
        const t = ev.type;

        if (t === "response.output_text.delta" && typeof ev.delta === "string") {
          startTextBlock();
          if (pendingText) pendingText.text += ev.delta;
          else pendingText = { index: contentBlockIndex, text: ev.delta };
          if (pendingText.text.length >= DELTA_FLUSH_BYTES) flushPendingText();
          return;
        }

        if (
          (t === "response.reasoning_summary_text.delta" ||
            t === "response.reasoning_text.delta" ||
            t === "response.reasoning.delta") &&
          typeof ev.delta === "string"
        ) {
          startThinkingBlock();
          if (pendingThinking) pendingThinking.text += ev.delta;
          else pendingThinking = { index: contentBlockIndex, text: ev.delta };
          if (pendingThinking.text.length >= DELTA_FLUSH_BYTES) flushPendingThinking();
          return;
        }

        if (t === "response.output_item.added" && ev.item) {
          const item = ev.item;
          if (item.type === "function_call") {
            const callId = item.call_id || item.id || `call_${ev.output_index ?? Date.now()}`;
            const name = item.name;
            if (typeof ev.output_index === "number") {
              toolByIndex.set(ev.output_index, { call_id: callId, name });
            }
            startToolBlock(callId, name);
          }
          return;
        }

        if (t === "response.function_call_arguments.delta" && typeof ev.delta === "string") {
          let callId = currentToolCallId;
          let name: string | undefined;
          if (!callId && typeof ev.output_index === "number") {
            const known = toolByIndex.get(ev.output_index);
            if (known) {
              callId = known.call_id;
              name = known.name;
            }
          }
          if (!callId) {
            callId = ev.item_id || `call_${ev.output_index ?? Date.now()}`;
          }
          if (!isToolUse || currentToolCallId !== callId) {
            startToolBlock(callId, name);
          }
          enqueueSSE(controller, "content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "input_json_delta", partial_json: ev.delta },
          });
          return;
        }

        if (t === "response.function_call_arguments.done") {
          // Arguments are already streamed via deltas; nothing extra needed.
          // Ensure the tool block exists so a later text block transitions cleanly.
          if (!isToolUse) {
            const callId = ev.call_id || currentToolCallId || `call_${Date.now()}`;
            startToolBlock(callId, ev.name);
          } else {
            sawFunctionCall = true;
          }
          return;
        }

        if (t === "response.completed" || t === "response.incomplete" || t === "response.failed") {
          const resp = ev.response || {};
          if (resp.usage) {
            lastUsage = {
              input_tokens: resp.usage.input_tokens ?? 0,
              output_tokens: resp.usage.output_tokens ?? 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            };
          }
          // If the completed output contains function calls but streaming
          // only sent the done event (no deltas), synthesize tool blocks
          // from the full output so tool calls are not lost.
          const output = Array.isArray(resp.output) ? resp.output : [];
          for (const item of output) {
            if (item?.type === "function_call") {
              const callId = item.call_id || item.id;
              if (!callId) continue;
              // If we already streamed this call, skip re-emitting.
              if (isToolUse && currentToolCallId === callId) continue;
              startToolBlock(callId, item.name);
              const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
              if (args && args !== "{}") {
                enqueueSSE(controller, "content_block_delta", {
                  type: "content_block_delta",
                  index: contentBlockIndex,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }
          }
          terminated = true;
          return;
        }

        if (t === "error") {
          terminated = true;
          return;
        }
      }

      const reader = responsesStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              for (const line of buffer.split("\n")) {
                if (line.trim().startsWith("data: ")) {
                  const data = line.slice(6).trim();
                  if (!data || data === "[DONE]") continue;
                  try { handleEvent(JSON.parse(data)); } catch { /* ignore */ }
                }
              }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.trim().startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (!data || data === "[DONE]") continue;
              try { handleEvent(JSON.parse(data)); } catch { continue; }
            }
          }
          if (terminated) {
            // Drain not needed — completed event is terminal for our purposes,
            // but keep reading to release the lock cleanly? Break and finish.
            // Cancel upstream to free resources.
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }

      flushPending();

      if (isToolUse || hasStartedTextBlock || hasStartedThinkingBlock) {
        enqueueSSE(controller, "content_block_stop", {
          type: "content_block_stop",
          index: contentBlockIndex,
        });
      } else if (!messageStarted) {
        // Upstream sent no content at all — still emit a valid empty message.
        ensureMessageStarted();
        contentBlockIndex = 0;
        enqueueSSE(controller, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        enqueueSSE(controller, "content_block_stop", {
          type: "content_block_stop",
          index: 0,
        });
      }

      enqueueSSE(controller, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: sawFunctionCall ? "tool_use" : "end_turn", stop_sequence: null },
        usage: lastUsage || { input_tokens: 0, output_tokens: 0 },
      });
      enqueueSSE(controller, "message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}
