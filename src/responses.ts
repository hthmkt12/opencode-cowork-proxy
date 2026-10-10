/**
 * Detect models served through the OpenAI Responses API
 * (`POST {upstream}/responses`) instead of Chat Completions
 * (`POST {upstream}/chat/completions`).
 *
 * Per https://opencode.ai/docs/zen/#endpoints (Oct 2026):
 * - GPT family: gpt-5*, gpt-6*  -> /v1/responses
 * - Grok family: grok-4*, grok-build-0.1 -> /v1/responses
 * - Muse Spark: muse-spark-1.2, muse-spark-1.3,
 *   muse-spark-1.3-contributor-free -> /v1/responses
 *
 * Everything else on Zen/Go that this proxy supports goes through
 * /chat/completions (deepseek, kimi, glm, minimax, qwen3.8-max,
 * free chat models like mimo-v2.6-flash-free, big-pickle, ...).
 */
export function isResponsesModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return /^(gpt-|grok-|muse-spark-)/.test(model);
}
