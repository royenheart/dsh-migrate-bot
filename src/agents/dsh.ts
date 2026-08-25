import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRequest, AgentResult, AgentRunner } from './types.ts'

const REPORT_FENCE = /^```(?:markdown)?\n([\s\S]*?)\n```$/m

/**
 * Last markdown document in the agent stdout, stripping a wrapping fence if present.
 */
export function extractReport(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed === '') return ''
  const fenced = trimmed.match(REPORT_FENCE)
  if (fenced?.[1] !== undefined) return fenced[1].trim()
  const heading = trimmed.lastIndexOf('\n# ')
  if (heading >= 0) return trimmed.slice(heading + 1).trim()
  return trimmed
}

export interface DshSpawn {
  (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{
    code: number
    stdout: string
    stderr: string
  }>
}

function defaultSpawn(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DSH_BIN ?? 'dsh', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Drive one dsh headless-style session through the migrate profile.
 * The profile (prepared in the container) mounts anchored-standard and pins V4 Pro / max.
 */
export function createDshRunner(options: {
  spawnImpl?: DshSpawn | undefined
  dshHome?: string | undefined
  reportDir?: string | undefined
} = {}): AgentRunner {
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  return {
    async run(request: AgentRequest): Promise<AgentResult> {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DEEPSEEK_API_KEY: request.apiKey,
        DSH_MIGRATE_PROVIDER: request.dsh.provider,
        DSH_MIGRATE_MODEL: request.dsh.model,
        DSH_MIGRATE_THINKING: request.dsh.thinking,
        DSH_MIGRATE_EFFORT: request.dsh.reasoningEffort,
        DSH_MIGRATE_MODE: request.dsh.mode,
        DSH_MIGRATE_TASK: request.prompt,
      }
      if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome

      const result = await spawnImpl(
        ['--profile', 'migrate', request.prompt],
        { cwd: request.workdir, env },
      )
      if (result.code !== 0) {
        throw new Error(`dsh agent failed (${result.code}): ${result.stderr || result.stdout}`)
      }
      const report = extractReport(result.stdout)
      if (options.reportDir !== undefined) {
        mkdirSync(options.reportDir, { recursive: true })
        writeFileSync(join(options.reportDir, `${request.kind}.raw.txt`), result.stdout, 'utf8')
      }
      return { report, raw: result.stdout }
    },
  }
}
