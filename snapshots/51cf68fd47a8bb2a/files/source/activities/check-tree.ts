import { CheckRunner, type CheckDeps } from './checks.ts'
import { inline } from '../render/text.ts'
import type { CheckName, CheckResult, Release } from '../workflow/model.ts'

/**
 * Check a whole tree once, outside a migration: the `publish` command runs this
 * on the tree a preview hands back before anything reaches the branch.
 *
 * It applies the policy a migration concludes with: the mechanical, boot and web
 * checks refuse; the end-to-end check refuses only under the `blocking` failure
 * policy; and a tree on which every check was skipped is refused, because
 * nothing verified it.
 */

export interface TreeCheckReport {
  ok: boolean
  results: CheckResult[]
  refusedBy?: CheckName | undefined
  release: Release
  detail: string
}

export async function checkTree(tree: string, release: Release, deps: Omit<CheckDeps, 'workdir'>): Promise<TreeCheckReport> {
  const runner = new CheckRunner({ ...deps, workdir: tree })
  const { boot, web, e2e } = deps.config.checks
  const order: CheckName[] = ['mechanical', ...(boot.enabled ? ['boot' as const] : []), ...(web.enabled ? ['web' as const] : []), ...(e2e.enabled ? ['e2e' as const] : [])]
  const results: CheckResult[] = []
  for (const check of order) {
    const result = await runner.run({ activity: 'check', check, release: 'target', e2eScope: 'full' }, release)
    results.push(result)
    const refuses = result.outcome === 'fail' && (check !== 'e2e' || e2e.failurePolicy === 'blocking')
    if (refuses) {
      return { ok: false, results, refusedBy: check, release, detail: inline(`the ${check} check failed: ${result.fingerprint}`, 300) }
    }
  }
  if (results.every(result => result.outcome === 'skipped')) {
    return { ok: false, results, release, detail: 'every check was skipped, so nothing verified this tree' }
  }
  return { ok: true, results, release, detail: results.map(result => `${result.check}: ${result.outcome}`).join(', ') }
}

/** One line per check, for a reply. */
export function renderTreeCheck(report: TreeCheckReport): string {
  return report.results.map(result => `- \`${result.check}\`: ${result.outcome}`).join('\n')
}
