import type { MigrateConfig } from '../config/schema.ts'
import type { MechanicalResult } from '../mechanical/run.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { ReportStore } from '../reports/store.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'

export type RunStatus = 'compatible' | 'migrated' | 'failed' | 'skipped'

export interface PublishResult {
  issueUrl?: string
  pullRequestUrl?: string
}

export interface PipelineResult {
  status: RunStatus
  mechanical: MechanicalResult
  published: PublishResult
  runDir: string
  skippedReview: boolean
  fixAttempts: number
}

export interface GithubPublisher {
  publish(input: {
    title: string
    issueBody: string
    prBody: string
    branch: string
    workdir: string
  }): Promise<PublishResult>
}

export interface PipelinePorts {
  config: MigrateConfig
  workdir: string
  target: ResolvedVersion
  store: ReportStore
  apiKey: string
  runMechanical: () => MechanicalResult
  isDirty: () => boolean
  diff: () => string
  agent: AgentRunner
  github?: GithubPublisher
}

export interface PipelineLogger {
  info(message: string): void
}
