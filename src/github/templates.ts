import type { IssuePrLanguage } from '../config/schema.ts'
import type { MechanicalResult } from '../mechanical/run.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'
import type { RunStatus, VerificationResult } from '../pipeline/types.ts'
import type { Attribution } from '../verify/baseline.ts'
import { formatAgentReport, formatErrorExcerpt, formatRootCause, formatWorkingTree } from './issue-format.ts'
import { inline } from '../render/text.ts'

export interface DocumentInput {
  language: IssuePrLanguage
  status: RunStatus
  target: ResolvedVersion
  pluginName: string
  skippedReview: boolean
  fixAttempts: number
  mechanical: MechanicalResult
  verdictA?: string | undefined
  verdictB?: string | undefined
  fixes?: readonly string[] | undefined
  diff: string
  verification?: VerificationResult | undefined
  attribution?: Attribution | undefined
}

/** Every verification layer names itself in both languages. */
const VERIFY_LABEL_EN: Record<VerificationResult['layer'], string> = {
  boot: 'boot probe',
  web: 'web smoke',
  e2e: 'E2E suite',
}

const VERIFY_LABEL_ZH: Record<VerificationResult['layer'], string> = {
  boot: 'boot 探针',
  web: 'Web 冒烟',
  e2e: 'E2E 套件',
}

/** Baseline attribution plus the last verification round, when either exists. */
function verificationSection(input: DocumentInput, language: IssuePrLanguage): string {
  const zh = language === 'zh'
  const lines: string[] = []
  if (input.attribution !== undefined) {
    lines.push(`${zh ? '基线归因' : 'Baseline'}: ${input.attribution.summary}`)
  }
  if (input.verification !== undefined) {
    const label = zh ? VERIFY_LABEL_ZH[input.verification.layer] : VERIFY_LABEL_EN[input.verification.layer]
    const state = input.verification.ok ? 'pass' : 'fail'
    const skipped = input.verification.skipped === undefined
      ? ''
      : ` (${zh ? '跳过' : 'skipped'}: ${input.verification.skipped})`
    lines.push(`${label}: ${state}${skipped}`)
    if (!input.verification.ok) {
      lines.push('', '```', inline(input.verification.detail.trim().slice(0, 4000) || input.verification.signature, 600), '```')
    }
  }
  if (lines.length === 0) return ''
  return `\n## ${zh ? '分层验证' : 'Layered verification'}\n\n${lines.join('\n')}\n`
}

function en(input: DocumentInput): { title: string; issue: string; pr: string } {
  const title = input.status === 'failed'
    ? `dsh ${inline(input.target.version, 80)}: migration incomplete for ${inline(input.pluginName, 120)}`
    : `dsh ${inline(input.target.version, 80)}: migrate ${inline(input.pluginName, 120)}`
  const issue = `# Migration report: ${inline(input.pluginName, 120)} × DeepSeek Harness ${inline(input.target.version, 80)}

## Summary

- Target harness: \`${inline(input.target.tag, 80)}\` (${inline(input.target.version, 80)})
- Outcome: **${input.status}**
- Review skipped: ${input.skippedReview ? 'yes' : 'no'}
- Repair loops: ${input.fixAttempts}
- Mechanical tests: ${input.mechanical.ok ? 'passed' : 'failed'}
${verificationSection(input, 'en')}
## Root cause

${formatRootCause({
    language: 'en',
    mechanicalOk: input.mechanical.ok,
    reportA: input.verdictA,
    reportB: input.verdictB,
    reportC: input.fixes?.at(-1),
  })}

## Official overlap (A)

${formatAgentReport(input.verdictA, '_Not run._')}

## Design alignment (B)

${formatAgentReport(input.verdictB, '_Not run._')}
${input.fixes !== undefined && input.fixes.length > 0
    ? `\n## Repair (C${input.fixes.length})\n\n${formatAgentReport(input.fixes.at(-1), '_Not run._')}\n`
    : ''}
## Mechanical test report

Status: ${input.mechanical.ok ? 'pass' : 'fail'}

${formatErrorExcerpt(input.mechanical.errors, '(no error excerpt)')}

## Working tree

${formatWorkingTree(input.diff, 'en')}

## Notes

Full A/B/C reports stay in the Action artifact / local \`.dsh-migrate/\` run directory and are not committed. Per-patch reports under \`.dsh-migrate/patch-reports/\` are posted as an Issue comment (index table, then each body).
`
  const pr = `## Summary

Automated migration toward DeepSeek Harness \`${inline(input.target.version, 80)}\` for \`${inline(input.pluginName, 120)}\`.

- Outcome: **${input.status}**
- Repair loops: ${input.fixAttempts}

## Test plan

- [ ] Mechanical suite on this branch (Action log)
- [ ] Install into a throwaway profile and boot \`dsh web\`
- [ ] Confirm documented capabilities and entry points still work
- [ ] Confirm no leftover shadow of an official surface that A marked \`retire\` / \`shrink\` only when official overlap absorbed that surface

## Root cause

See the companion Issue. Mechanical excerpt:

${formatErrorExcerpt(input.mechanical.errors, '(clean)')}

## Risk

Preview-era harness APIs still move. Re-run the Action when the next \`dsh-v*\` tag lands.
`
  return { title, issue, pr }
}

function zh(input: DocumentInput): { title: string; issue: string; pr: string } {
  const title = input.status === 'failed'
    ? `dsh ${inline(input.target.version, 80)}：${inline(input.pluginName, 120)} 迁移未完成`
    : `dsh ${inline(input.target.version, 80)}：迁移 ${inline(input.pluginName, 120)}`
  const issue = `# 迁移报告：${inline(input.pluginName, 120)} × DeepSeek Harness ${inline(input.target.version, 80)}

## 摘要

- 目标 harness：\`${inline(input.target.tag, 80)}\`（${inline(input.target.version, 80)}）
- 结果：**${input.status}**
- 是否跳过复核：${input.skippedReview ? '是' : '否'}
- 修复循环次数：${input.fixAttempts}
- 机械测试：${input.mechanical.ok ? '通过' : '失败'}
${verificationSection(input, 'zh')}
## 根因

${formatRootCause({
    language: 'zh',
    mechanicalOk: input.mechanical.ok,
    reportA: input.verdictA,
    reportB: input.verdictB,
    reportC: input.fixes?.at(-1),
  })}

## 官方重叠（A）

${formatAgentReport(input.verdictA, '_未运行。_')}

## 设计对齐（B）

${formatAgentReport(input.verdictB, '_未运行。_')}
${input.fixes !== undefined && input.fixes.length > 0
    ? `\n## 修复（C${input.fixes.length}）\n\n${formatAgentReport(input.fixes.at(-1), '_未运行。_')}\n`
    : ''}
## 机械测试报告

状态：${input.mechanical.ok ? '通过' : '失败'}

${formatErrorExcerpt(input.mechanical.errors, '（无错误摘录）')}

## 工作区变更

${formatWorkingTree(input.diff, 'zh')}

## 说明

完整 A/B/C 报告只存在于 Action artifact / 本地 \`.dsh-migrate/\`，不入库。每个补丁的 report 在 \`.dsh-migrate/patch-reports/\`，会作为 Issue 评论贴出（先总表，再各正文）。
`
  const pr = `## 摘要

针对 DeepSeek Harness \`${inline(input.target.version, 80)}\` 的自动迁移（\`${inline(input.pluginName, 120)}\`）。

- 结果：**${input.status}**
- 修复循环：${input.fixAttempts}

## 测试计划

- [ ] 本分支再跑一遍机械检测
- [ ] 装进一次性 profile 并启动 \`dsh web\`
- [ ] 确认文档中的能力与入口仍在
- [ ] 仅当官方重叠真正吸收了该面时，确认 A 判定为 \`retire\` / \`shrink\` 的面已被去掉

## 根因

见配套 Issue。机械摘录：

${formatErrorExcerpt(input.mechanical.errors, '（干净）')}

## 风险

预览期 API 仍会变。下一个 \`dsh-v*\` 标签到来时请再跑本 Action。
`
  return { title, issue, pr }
}

export function renderDocuments(input: DocumentInput): { title: string; issue: string; pr: string } {
  return input.language === 'zh' ? zh(input) : en(input)
}
