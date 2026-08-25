import type { IssuePrLanguage } from '../config/schema.ts'
import type { MechanicalResult } from '../mechanical/run.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'
import type { RunStatus } from '../pipeline/types.ts'

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
  diff: string
}

function firstHeadingBlock(markdown: string | undefined, fallback: string): string {
  if (markdown === undefined || markdown.trim() === '') return fallback
  const lines = markdown.trim().split(/\r?\n/).slice(0, 12)
  return lines.join('\n')
}

function en(input: DocumentInput): { title: string; issue: string; pr: string } {
  const title = input.status === 'failed'
    ? `dsh ${input.target.version}: migration incomplete for ${input.pluginName}`
    : `dsh ${input.target.version}: migrate ${input.pluginName}`
  const issue = `# Migration report: ${input.pluginName} × DeepSeek Harness ${input.target.version}

## Summary

- Target harness: \`${input.target.tag}\` (${input.target.version})
- Outcome: **${input.status}**
- Review skipped: ${input.skippedReview ? 'yes' : 'no'}
- Repair loops: ${input.fixAttempts}
- Mechanical tests: ${input.mechanical.ok ? 'passed' : 'failed'}

## Root cause

${input.mechanical.ok
    ? 'Mechanical checks passed on the resulting tree. Remaining product questions are in the overlap and alignment summaries below.'
    : 'Mechanical checks still fail. The error excerpt is the immediate cause; alignment/overlap reports describe the intended fix.'}

## Official overlap (A)

${firstHeadingBlock(input.verdictA, '_Not run._')}

## Design alignment (B)

${firstHeadingBlock(input.verdictB, '_Not run._')}

## Mechanical test report

Status: ${input.mechanical.ok ? 'pass' : 'fail'}

\`\`\`
${input.mechanical.errors || '(no error excerpt)'}
\`\`\`

## Working tree

${input.diff.trim() === '' ? '_No file changes._' : `\`\`\`diff\n${input.diff.slice(0, 8000)}\n\`\`\``}

## Notes

Full A/B/C reports stay in the Action artifact / local \`.dsh-migrate/\` run directory and are not committed.
`
  const pr = `## Summary

Automated migration toward DeepSeek Harness \`${input.target.version}\` for \`${input.pluginName}\`.

- Outcome: **${input.status}**
- Repair loops: ${input.fixAttempts}

## Test plan

- [ ] Mechanical suite on this branch (Action log)
- [ ] Install into a throwaway profile and boot \`dsh web\`
- [ ] Confirm unique plugin behavior still works
- [ ] Confirm no leftover shadow of an official surface that A marked \`retire\` / \`shrink\`

## Root cause

See the companion Issue. Mechanical excerpt:

\`\`\`
${input.mechanical.errors || '(clean)'}
\`\`\`

## Risk

Preview-era harness APIs still move. Re-run the Action when the next \`dsh-v*\` tag lands.
`
  return { title, issue, pr }
}

function zh(input: DocumentInput): { title: string; issue: string; pr: string } {
  const title = input.status === 'failed'
    ? `dsh ${input.target.version}：${input.pluginName} 迁移未完成`
    : `dsh ${input.target.version}：迁移 ${input.pluginName}`
  const issue = `# 迁移报告：${input.pluginName} × DeepSeek Harness ${input.target.version}

## 摘要

- 目标 harness：\`${input.target.tag}\`（${input.target.version}）
- 结果：**${input.status}**
- 是否跳过复核：${input.skippedReview ? '是' : '否'}
- 修复循环次数：${input.fixAttempts}
- 机械测试：${input.mechanical.ok ? '通过' : '失败'}

## 根因

${input.mechanical.ok
    ? '工作区机械检测已通过。产品层结论见下方重叠与对齐摘要。'
    : '机械检测仍失败。错误摘录是直接原因；重叠/对齐报告说明预期改法。'}

## 官方重叠（A）

${firstHeadingBlock(input.verdictA, '_未运行。_')}

## 设计对齐（B）

${firstHeadingBlock(input.verdictB, '_未运行。_')}

## 机械测试报告

状态：${input.mechanical.ok ? '通过' : '失败'}

\`\`\`
${input.mechanical.errors || '（无错误摘录）'}
\`\`\`

## 工作区变更

${input.diff.trim() === '' ? '_无文件改动。_' : `\`\`\`diff\n${input.diff.slice(0, 8000)}\n\`\`\``}

## 说明

完整 A/B/C 报告只存在于 Action artifact / 本地 \`.dsh-migrate/\`，不入库。
`
  const pr = `## 摘要

针对 DeepSeek Harness \`${input.target.version}\` 的自动迁移（\`${input.pluginName}\`）。

- 结果：**${input.status}**
- 修复循环：${input.fixAttempts}

## 测试计划

- [ ] 本分支再跑一遍机械检测
- [ ] 装进一次性 profile 并启动 \`dsh web\`
- [ ] 确认插件独有行为仍在
- [ ] 确认 A 判定为 \`retire\` / \`shrink\` 的官方重叠面已被去掉

## 根因

见配套 Issue。机械摘录：

\`\`\`
${input.mechanical.errors || '（干净）'}
\`\`\`

## 风险

预览期 API 仍会变。下一个 \`dsh-v*\` 标签到来时请再跑本 Action。
`
  return { title, issue, pr }
}

export function renderDocuments(input: DocumentInput): { title: string; issue: string; pr: string } {
  return input.language === 'zh' ? zh(input) : en(input)
}
