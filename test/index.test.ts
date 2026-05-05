import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';

const key = 'a'.repeat(32);

describe('worker routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes /v1/models to Anthropic models endpoint with Anthropic headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models', {
      headers: {
        'x-api-key': key,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
      },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      },
    });
  });

  it('forwards Anthropic beta header when translating OpenAI requests to Anthropic', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
        'anthropic-beta': 'tools-2024-04-04',
      },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      }),
    }));
  });
});
