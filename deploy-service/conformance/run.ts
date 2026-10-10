#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { runConformance } from './suite.ts'

/**
 * Run the conformance suite against a deploy service.
 *
 *   node dist/conformance/run.js --url https://deploy.example.com --token "$DEPLOY_TOKEN" [--conformance] [--preview owner/name#N]
 *
 * The token may also come from `DEPLOY_TOKEN`, which keeps it out of the
 * process list. The exit status is 0 when no check failed; a skipped check is
 * reported with its reason and does not fail the run.
 */

const USAGE = 'usage: run.js --url URL --token TOKEN [--conformance] [--preview owner/name#N]\n'

function main(): Promise<number> | number {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      conformance: { type: 'boolean' },
      preview: { type: 'string' },
    },
    strict: true,
  })
  const token = values.token ?? process.env.DEPLOY_TOKEN
  if (values.url === undefined || token === undefined || token === '') {
    process.stderr.write(USAGE)
    return 2
  }
  let endpoint: string
  try {
    const parsed = new URL(values.url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('not http(s)')
    endpoint = parsed.href.replace(/\/+$/, '')
  } catch {
    process.stderr.write(`--url ${values.url} is not an http(s) URL\n${USAGE}`)
    return 2
  }
  let preview: { repository: string; pullRequest: number } | undefined
  if (values.preview !== undefined) {
    const [repository, number] = values.preview.split('#')
    if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || number === undefined || !/^[1-9][0-9]*$/.test(number)) {
      process.stderr.write(`--preview ${values.preview} is not owner/name#N\n${USAGE}`)
      return 2
    }
    preview = { repository, pullRequest: Number(number) }
  }
  return runConformance({ service: { endpoint, token }, conformance: values.conformance === true, preview }).then((outcomes) => {
    for (const outcome of outcomes) {
      const label = outcome.status === 'pass' ? 'ok  ' : outcome.status === 'skip' ? 'skip' : 'FAIL'
      process.stdout.write(`${label}  ${outcome.name}${outcome.detail === '' ? '' : `: ${outcome.detail}`}\n`)
    }
    const failed = outcomes.filter(outcome => outcome.status === 'fail').length
    const skipped = outcomes.filter(outcome => outcome.status === 'skip').length
    process.stdout.write(`conformance: ${String(outcomes.length - failed - skipped)} passed, ${String(failed)} failed, ${String(skipped)} skipped against ${endpoint}\n`)
    return failed === 0 ? 0 : 1
  })
}

void Promise.resolve(main()).then((code) => { process.exitCode = code })
