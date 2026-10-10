import { describe, it, expect } from 'vitest';
import { isResponsesModel } from '../src/responses';
import { formatAnthropicToResponses } from '../src/translate/request/anthropic-to-responses';
import { formatResponsesToAnthropic } from '../src/translate/response/responses-to-anthropic';
import { streamResponsesToAnthropic } from '../src/translate/stream/responses-to-anthropic';

describe('isResponsesModel', () => {
  it('matches muse-spark free and paid IDs', () => {
    expect(isResponsesModel('muse-spark-1.3-contributor-free')).toBe(true);
    expect(isResponsesModel('muse-spark-1.3')).toBe(true);
    expect(isResponsesModel('muse-spark-1.2')).toBe(true);
  });
  it('matches gpt and grok responses models', () => {
    expect(isResponsesModel('gpt-5.5')).toBe(true);
    expect(isResponsesModel('gpt-6-sol')).toBe(true);
    expect(isResponsesModel('grok-4.5')).toBe(true);
    expect(isResponsesModel('grok-build-0.1')).toBe(true);
  });
  it('does not match chat-completions models', () => {
    expect(isResponsesModel('deepseek-v4-flash')).toBe(false);
    expect(isResponsesModel('mimo-v2.6-flash-free')).toBe(false);
    expect(isResponsesModel('kimi-k2.6')).toBe(false);
    expect(isResponsesModel('claude-sonnet-4-5-20250514')).toBe(false);
    expect(isResponsesModel(null)).toBe(false);
  });
});

describe('formatAnthropicToResponses', () => {
  it('converts text messages and system prompt to input array', () => {
    const out = formatAnthropicToResponses({
      model: 'muse-spark-1.3-contributor-free',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      stream: false,
    });
    expect(out.model).toBe('muse-spark-1.3-contributor-free');
    expect(out.max_output_tokens).toBe(100);
    expect(out.input).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('converts image blocks to input_image parts', () => {
    const out = formatAnthropicToResponses({
      model: 'muse-spark-1.3-contributor-free',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      }],
    });
    expect(out.input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'see?' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc' },
      ],
    });
  });

  it('converts tools and tool_result/tool_use history', () => {
    const out = formatAnthropicToResponses({
      model: 'muse-spark-1.3-contributor-free',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'HN' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'sunny' }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
    });
    expect(out.tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' } },
    ]);
    expect(out.input).toContainEqual({
      type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"HN"}',
    });
    expect(out.input).toContainEqual({
      type: 'function_call_output', call_id: 'c1', output: 'sunny',
    });
  });
});

describe('formatResponsesToAnthropic', () => {
  it('maps output_text to text blocks with usage', () => {
    const out = formatResponsesToAnthropic({
      id: 'resp_1',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }, 'muse-spark-1.3-contributor-free');
    expect(out.model).toBe('muse-spark-1.3-contributor-free');
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 });
  });

  it('maps function_call to tool_use with tool_use stop reason', () => {
    const out = formatResponsesToAnthropic({
      output: [{ type: 'function_call', call_id: 'c9', name: 'fn', arguments: '{"a":1}' }],
    }, 'm');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c9', name: 'fn', input: { a: 1 } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('maps reasoning summary to thinking blocks', () => {
    const out = formatResponsesToAnthropic({
      output: [{ type: 'reasoning', summary: [{ text: 'plan' }] }],
    }, 'm');
    expect(out.content[0].type).toBe('thinking');
    expect(out.content[0].thinking).toContain('plan');
  });
});

function sseStream(chunks: string[]): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collectAnthropicSSE(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

describe('streamResponsesToAnthropic', () => {
  it('translates output_text deltas to Anthropic text events', async () => {
    const upstream = sseStream([
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":1,"output_tokens":2}}}\n\n',
    ]);
    const text = await collectAnthropicSSE(streamResponsesToAnthropic(upstream, 'm'));
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('text_delta');
    expect(text).toContain('Hello');
  });

  it('translates function call deltas to tool_use events', async () => {
    const upstream = sseStream([
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\""}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":":\\"HN\\"}"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"HN\\"}"}],"usage":{"input_tokens":5,"output_tokens":5}}}\n\n',
    ]);
    const text = await collectAnthropicSSE(streamResponsesToAnthropic(upstream, 'm'));
    expect(text).toContain('tool_use');
    expect(text).toContain('get_weather');
    expect(text).toContain('input_json_delta');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});
