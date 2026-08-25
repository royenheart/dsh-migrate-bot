import type { DshBackendConfig } from '../config/schema.ts'
import type { SessionProgress } from './session-status.ts'

export type AgentKind = 'absorption' | 'alignment' | 'fix'

export interface AgentRequest {
  kind: AgentKind
  prompt: string
  workdir: string
  dsh: DshBackendConfig
  apiKey: string
  usageSoFar?: number | undefined
  usageLimit?: number | undefined
}

export interface AgentResult {
  report: string
  raw: string
  usage?: SessionProgress | undefined
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>
}
