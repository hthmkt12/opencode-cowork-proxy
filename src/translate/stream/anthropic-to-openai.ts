/**
 * Converts Anthropic Messages streaming SSE to OpenAI Chat Completions streaming SSE.
 */

// Coalesce consecutive same-type deltas before enqueueing. Dense reasoning
// streams emit thousands of small deltas per second; each enqueue + JSON
// stringify costs CPU and pushes the Worker over the 10ms Free-plan limit.
// 1KB batches cut enqueue count 50-100x with no perceptible latency.
const DELTA_FLUSH_BYTES = 1024;

export function streamAnthropicToOpenAI(anthropicStream: ReadableStream, model: string): ReadableStream {
  const chatId = "chatcmpl-" + Math.floor(Date.now() / 1000);

  const enqueueSSE = (controller: ReadableStreamDefaultController, data: any) => {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  return new ReadableStream({
    async start(controller) {
      const reader = anthropicStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Tool call tracking: index → { id, name, args }
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
      let contentBlockIndex = -1;
      let activeBlockType: "text" | "thinking" | "tool_use" | null = null;

      // Pending deltas: accumulate same-type deltas so we enqueue once per
      // batch instead of once per token. Flushed on type transition, size
      // threshold, or stream end. See DELTA_FLUSH_BYTES above.
      let pendingText: string | null = null;
      let pendingReasoning: string | null = null;

      const nowSec = () => Math.floor(Date.now() / 1000);

      const emitTextChunk = (text: string) => {
        enqueueSSE(controller, {
          id: chatId,
          object: "chat.completion.chunk",
          created: nowSec(),
          model,
          choices: [{ index: 0, delta: { content: text } }],
        });
      };
      const emitReasoningChunk = (text: string) => {
        enqueueSSE(controller, {
          id: chatId,
          object: "chat.completion.chunk",
          created: nowSec(),
          model,
          choices: [{ index: 0, delta: { reasoning_content: text } }],
        });
      };
      const flushPendingText = () => {
        if (pendingText !== null) {
          emitTextChunk(pendingText);
          pendingText = null;
        }
      };
      const flushPendingReasoning = () => {
        if (pendingReasoning !== null) {
          emitReasoningChunk(pendingReasoning);
          pendingReasoning = null;
        }
      };
      const flushPending = () => { flushPendingText(); flushPendingReasoning(); };

      function emitChunk(delta: any, finishReason?: string) {
        const chunk: any = {
          id: chatId,
          object: "chat.completion.chunk",
          created: nowSec(),
          model,
          choices: [{ index: 0, delta }],
        };
        if (finishReason) chunk.choices[0].finish_reason = finishReason;
        enqueueSSE(controller, chunk);
      }

      function processEvents(lines: string[]) {
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let evt: any;
          try { evt = JSON.parse(raw); } catch { continue; }

          switch (evt.type) {
            case "message_start":
              // Defensive: flush any leftover deltas from a prior message
              flushPending();
              contentBlockIndex = -1;
              activeBlockType = null;
              toolCallMap.clear();
              break;

            case "content_block_start": {
              const block = evt.content_block;
              contentBlockIndex = evt.index;

              if (block?.type === "text") {
                activeBlockType = "text";
              } else if (block?.type === "thinking") {
                activeBlockType = "thinking";
              } else if (block?.type === "tool_use") {
                activeBlockType = "tool_use";
                // Tool use interrupts any pending text/thinking deltas
                flushPending();
                // Emit the initial tool_call chunk with id, name, empty args
                const tcId = block.id || `call_${Date.now()}`;
                toolCallMap.set(contentBlockIndex, { id: tcId, name: block.name || "", args: "" });
                emitChunk({
                  tool_calls: [{
                    index: contentBlockIndex,
                    id: tcId,
                    type: "function",
                    function: { name: block.name || "", arguments: "" },
                  }],
                });
              }
              break;
            }

            case "content_block_delta": {
              const delta = evt.delta;
              if (delta?.type === "text_delta") {
                // Transition from reasoning to text: flush reasoning first
                if (pendingReasoning !== null) flushPendingReasoning();

                const next = (pendingText ?? "") + (delta.text || "");
                if (next.length >= DELTA_FLUSH_BYTES) {
                  emitTextChunk(next);
                  pendingText = null;
                } else {
                  pendingText = next;
                }
              } else if (delta?.type === "thinking_delta") {
                // Transition from text to reasoning: flush text first
                if (pendingText !== null) flushPendingText();

                const next = (pendingReasoning ?? "") + (delta.thinking || "");
                if (next.length >= DELTA_FLUSH_BYTES) {
                  emitReasoningChunk(next);
                  pendingReasoning = null;
                } else {
                  pendingReasoning = next;
                }
              } else if (delta?.type === "input_json_delta") {
                // Tool call: flush any pending text/thinking first
                flushPending();
                // Accumulate and emit tool call argument deltas
                const tc = toolCallMap.get(contentBlockIndex);
                if (tc) {
                  tc.args += delta.partial_json || "";
                  emitChunk({
                    tool_calls: [{
                      index: contentBlockIndex,
                      function: { arguments: delta.partial_json || "" },
                    }],
                  });
                }
              }
              break;
            }

            case "content_block_stop":
              activeBlockType = null;
              break;

            case "message_delta": {
              // Structural event: flush any pending text/thinking first
              flushPending();
              const stopReason = evt.delta?.stop_reason;
              if (stopReason) {
                const finishReason = stopReason === "tool_use" ? "tool_calls" : "stop";
                emitChunk({}, finishReason);
              }
              break;
            }

            case "message_stop":
              // Nothing extra needed
              break;
          }
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Process complete SSE frames (delimited by double newline)
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || ""; // keep incomplete last part

          for (const frame of parts) {
            if (frame.trim()) {
              processEvents(frame.split("\n"));
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          processEvents(buffer.split("\n"));
        }
      } finally {
        reader.releaseLock();
      }

      // Flush any remaining pending deltas before sending the terminator
      flushPending();

      // Send [DONE]
      enqueueSSE(controller, "[DONE]");
      controller.close();
    },
  });
}
