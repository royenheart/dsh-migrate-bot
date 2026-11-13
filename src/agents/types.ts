import type { AgentConfig } from '../config/schema.ts'
import type { SessionObservation } from '../observability/session.ts'
import type { SessionProgress } from './session-status.ts'

export type AgentKind = 'overlap' | 'extension-points' | 'repair' | 'e2e-authoring' | 'report'

export interface AgentRequest {
  kind: AgentKind
  /** The evidence name when one kind runs more than once, such as the two e2e-authoring calls. */
  name?: string | undefined
  prompt: string
  workdir: string
  agent: AgentConfig
  apiKey: string
  /** Explicit credential values that must not reach reports or traces. */
  secrets?: readonly string[] | undefined
  usageSoFar?: number | undefined
  usageLimit?: number | undefined
  /** Environment the session's tools see, such as the address of a running `dsh web`. */
  env?: Record<string, string> | undefined
  /** Structured session events for the run manifest and Langfuse. */
  onObservation?: ((observation: SessionObservation) => void) | undefined
}

export interface AgentResult {
  report: string
  raw: string
  /** Unredacted output used only to parse a structured report payload; never published. */
  payload?: string | undefined
  usage?: SessionProgress | undefined
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>
}
