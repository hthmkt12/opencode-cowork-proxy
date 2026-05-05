/**
 * Prompt cache key generation and cache token extraction utilities.
 * Bridges Anthropic's explicit cache_control markers with OpenAI's automatic prefix caching.
 */

/** djb2 hash of system prompt text, used as prompt_cache_key for OpenAI node affinity */
export function hashSystemPrompt(system: string | any[] | undefined): string | null {
  if (!system) return null;
  const text = typeof system === 'string'
    ? system
    : system.map((s: any) => s.text || '').join('\n');
  if (!text.trim()) return null;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return 'cache-' + Math.abs(hash).toString(36);
}

/** Check if any message or system prompt has Anthropic cache_control markers */
export function hasCacheControl(messages: any[], system?: any): boolean {
  if (Array.isArray(system)) {
    if (system.some((s: any) => s.cache_control)) return true;
  }
  if (typeof system === 'object' && system?.cache_control) return true;
  for (const msg of messages || []) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some((block: any) => block.cache_control)) return true;
    }
  }
  return false;
}

/** Extract cached_tokens from OpenAI usage.prompt_tokens_details */
export function extractCachedTokens(usage: any): number {
  return usage?.prompt_tokens_details?.cached_tokens || 0;
}
