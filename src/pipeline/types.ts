import type { MigrateConfig } from '../config/schema.ts'
import type { MechanicalResult } from '../mechanical/run.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { ReportStore } from '../reports/store.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'
import type { QuotaSnapshot } from '../quota/types.ts'

export type RunStatus = 'compatible' | 'migrated' | 'failed' | 'skipped'

export interface PublishResult {
  issueUrl?: string
  issueNumber?: number
  pullRequestUrl?: string
  pullRequestNumber?: number
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
  commentIssue?(issueNumber: number, body: string, workdir: string): Promise<void>
}

export interface QuotaPort {
  query(): Promise<QuotaSnapshot>
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
  quota?: QuotaPort
  harness?: { path: string; tag: string } | undefined
}

export interface PipelineLogger {
  info(message: string): void
}
