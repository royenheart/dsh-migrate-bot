import type { DshBackendConfig } from '../config/schema.ts'

export type AgentKind = 'absorption' | 'alignment' | 'fix'

export interface AgentRequest {
  kind: AgentKind
  prompt: string
  workdir: string
  dsh: DshBackendConfig
  apiKey: string
}

export interface AgentResult {
  report: string
  raw: string
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>
}
