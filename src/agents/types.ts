import type { AgentConfig } from '../config/schema.ts'
import type { SessionProgress } from './session-status.ts'

export type AgentKind = 'overlap' | 'extension-points' | 'repair' | 'e2e-authoring' | 'report'

export interface AgentRequest {
  kind: AgentKind
  prompt: string
  workdir: string
  agent: AgentConfig
  apiKey: string
  usageSoFar?: number | undefined
  usageLimit?: number | undefined
  /** Environment the session's tools see, such as the address of a running `dsh web`. */
  env?: Record<string, string> | undefined
}

export interface AgentResult {
  report: string
  raw: string
  usage?: SessionProgress | undefined
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>
}
