/**
 * Session-event fixtures shaped like DeepSeek usage as dsh persists it.
 * Timestamps are Beijing wall times (peak ~08:30–00:30, off-peak ~00:30–08:30)
 * so you can inspect them; the Action does not bill from these clocks.
 *
 * Two encodings appear in the wild:
 * - harness TokenUsage: `inputTokens` is uncached (miss); `cacheReadTokens` is hit
 * - official wire: `prompt_tokens` includes hits; `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 */
export const SESSION_USAGE_FIXTURES = {
  peakMissHeavy: {
    name: 'peak-miss-heavy',
    time: '2026-08-17T10:30:00+08:00',
    events: [
      { type: 'turn/start', time: Date.parse('2026-08-17T10:30:00+08:00'), data: { turn: 1 } },
      { type: 'step/start', time: Date.parse('2026-08-17T10:30:01+08:00'), data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        time: Date.parse('2026-08-17T10:30:20+08:00'),
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 8000,
            outputTokens: 400,
            cacheReadTokens: 2000,
          },
        },
      },
    ],
    expected: { turns: 1, steps: 1, inputTokens: 8000, outputTokens: 400, cacheHitTokens: 2000, cacheMissTokens: 8000 },
  },
  offPeakHitHeavy: {
    name: 'off-peak-hit-heavy',
    time: '2026-08-18T02:15:00+08:00',
    events: [
      { type: 'turn/start', time: Date.parse('2026-08-18T02:15:00+08:00'), data: { turn: 1 } },
      { type: 'step/start', time: Date.parse('2026-08-18T02:15:01+08:00'), data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk',
        time: Date.parse('2026-08-18T02:15:40+08:00'),
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'usage',
            usage: {
              prompt_tokens: 12500,
              completion_tokens: 150,
              prompt_cache_hit_tokens: 12000,
              prompt_cache_miss_tokens: 500,
            },
          },
        },
      },
    ],
    expected: { turns: 1, steps: 1, inputTokens: 500, outputTokens: 150, cacheHitTokens: 12000, cacheMissTokens: 500 },
  },
  missOnlyNoCacheFields: {
    name: 'miss-only-no-cache-fields',
    time: '2026-08-18T15:00:00+08:00',
    events: [
      { type: 'turn/start', time: Date.parse('2026-08-18T15:00:00+08:00'), data: { turn: 2 } },
      { type: 'step/start', time: Date.parse('2026-08-18T15:00:01+08:00'), data: { turn: 2, step: 1 } },
      {
        type: 'assistant/message',
        time: Date.parse('2026-08-18T15:00:12+08:00'),
        data: {
          turn: 2,
          step: 1,
          usage: { inputTokens: 300, outputTokens: 80 },
        },
      },
    ],
    expected: { turns: 1, steps: 1, inputTokens: 300, outputTokens: 80, cacheHitTokens: 0, cacheMissTokens: 300 },
  },
} as const
