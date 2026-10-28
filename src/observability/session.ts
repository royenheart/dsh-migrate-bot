import type { AgentConfig } from '../config/schema.ts'

/**
 * The evidence a session leaves behind. A manifest holds hashes and links; the
 * run directory holds the prompt text and the observations Langfuse receives.
 */

export interface SessionObservation {
  seq: number
  /** Unix milliseconds. */
  time: number
  type: 'assistant' | 'tool-call' | 'tool-result' | 'turn-start' | 'turn-end' | 'usage' | 'other'
  turn?: number | undefined
  step?: number | undefined
  text?: string | undefined
  reasoning?: string | undefined
  tool?: { name: string; arguments?: string | undefined; result?: string | undefined; failed?: boolean | undefined } | undefined
  usage?: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | undefined
}

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  usd?: number | undefined
}

export interface SessionRecord {
  kind: string
  /** The report name, such as `overlap` or `repair-1`. */
  name: string
  prompt: string
  promptSha256: string
  startedAt: string
  endedAt: string
  outcome: 'completed' | 'failed' | 'spend-cap'
  output?: string | undefined
  usage?: SessionUsage | undefined
  progress?: { turns: number; steps: number; elapsedSeconds: number } | undefined
  toolCalls: number
  observations: SessionObservation[]
}

export interface SessionObserver {
  record(session: SessionRecord): void
  recordCheck?(check: ManifestCheck): void
}

export interface ManifestCheck {
  check: string
  outcome: 'pass' | 'fail' | 'skipped'
}

export interface AgentIdentity {
  runtime: string
  skill: string
  model: AgentConfig
}
