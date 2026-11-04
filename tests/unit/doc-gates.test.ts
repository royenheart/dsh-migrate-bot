import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  documentAnchors,
  githubSlug,
  headingsOf,
  isExternalTarget,
  linksOf,
  splitTarget,
  stripInlineMarkdown,
} from '../../scripts/md.ts'
import { parseIndexRows, verifyIndexShape } from '../../scripts/verify-doc-index.ts'
import { verifyChangelog } from '../../scripts/verify-changelog.ts'
import { verifyProposalSource, verifyProposals } from '../../scripts/verify-proposals.ts'

test('verify-changelog accepts a generated changelog', () => {
  const source = '# Changelog\n\nintro\n\n## v0.2.0 (2026-01-01)\n\n### Feat\n\n- a thing\n\n## v0.1.0 (2026-01-01)\n\n### Feat\n\n- first\n'
  const result = verifyChangelog(source)
  assert.deepEqual(result.violations, [])
  assert.equal(result.releases, 2)
})

test('verify-changelog allows the Unreleased section a full regeneration emits', () => {
  const source = '# Changelog\n\n## Unreleased\n\n### Feat\n\n- pending\n\n## v0.1.0 (2026-01-01)\n\n### Feat\n\n- first\n'
  assert.deepEqual(verifyChangelog(source).violations, [])
})

test('verify-changelog rejects a duplicated header', () => {
  // The defect this gate exists for: a template that emits the header on both
  // the regeneration path and the bump path renders fine and duplicates it.
  const source = '# Changelog\n\n## v0.1.0 (2026-01-01)\n\n### Feat\n\n- first\n\n# Changelog\n\n## v0.0.9 (2026-01-01)\n\n### Feat\n\n- older\n'
  const { violations } = verifyChangelog(source)
  assert.equal(violations.length, 1)
  assert.match(violations[0]?.detail ?? '', /appears 2 times/)
})

test('verify-changelog rejects a missing header and a misplaced one', () => {
  const missing = verifyChangelog('## v0.1.0 (2026-01-01)\n')
  assert.match(missing.violations[0]?.detail ?? '', /missing/)
  const offset = verifyChangelog('intro\n\n# Changelog\n\n## v0.1.0 (2026-01-01)\n')
  assert.match(offset.violations[0]?.detail ?? '', /must be the first line/)
})

test('verify-changelog rejects a hand-written section beside generated ones', () => {
  const source = '# Changelog\n\n## [0.1.0] — 2026-01-01\n\n### Added\n\n- hand written\n'
  assert.match(verifyChangelog(source).violations[0]?.detail ?? '', /unexpected section/)
})

test('githubSlug matches GitHub, including its punctuation removal', () => {
  assert.equal(githubSlug('Security and authority are non-goals'), 'security-and-authority-are-non-goals')
  assert.equal(githubSlug('Comparability (not done yet)'), 'comparability-not-done-yet')
  assert.equal(githubSlug('3. The gate stack'), '3-the-gate-stack')
  assert.equal(githubSlug('The record format (`schema: 1`)'), 'the-record-format-schema-1')
  // Removing the em dash leaves two spaces, which become two hyphens. That is
  // what GitHub produces, so the gate must agree with it rather than "fix" it.
  assert.equal(githubSlug('1. Oracle self-check — no Harbor'), '1-oracle-self-check--no-harbor')
})

test('documentAnchors suffixes repeated headings the way GitHub does', () => {
  const anchors = documentAnchors('# Repeat\n\n## Repeat\n\n### Repeat\n')
  assert.deepEqual([...anchors].sort(), ['repeat', 'repeat-1', 'repeat-2'])
})

test('documentAnchors collects explicit <a id> anchors and ignores commented ones', () => {
  const anchors = documentAnchors('<a id="pinned"></a>\n\n<!-- <a id="hidden"></a> -->\n')
  assert.ok(anchors.has('pinned'))
  assert.ok(!anchors.has('hidden'))
})

test('headingsOf reports levels, line numbers, and rendered text', () => {
  const headings = headingsOf('# One\n\ntext\n\n## Two `code`\n')
  assert.deepEqual(headings, [
    { level: 1, text: 'One', line: 1 },
    { level: 2, text: 'Two code', line: 5 },
  ])
})

test('headingsOf and linksOf ignore fenced code blocks', () => {
  const source = '# Real\n\n```sh\n# not a heading\nsee [x](missing.md)\n```\n\n~~~\n## also not\n~~~\n'
  assert.deepEqual(
    headingsOf(source).map(heading => heading.text),
    ['Real'],
  )
  assert.deepEqual(linksOf(source), [])
})

test('linksOf skips inline code spans and keeps line numbers', () => {
  const source = 'a [real](docs/a.md) b\n\n`[not](docs/b.md)`\n\n![img](docs/c.png)\n'
  assert.deepEqual(linksOf(source), [
    { url: 'docs/a.md', line: 1 },
    { url: 'docs/c.png', line: 5 },
  ])
})

test('linksOf also finds reference definitions', () => {
  assert.deepEqual(linksOf('[label]: docs/a.md\n'), [{ url: 'docs/a.md', line: 1 }])
})

test('stripInlineMarkdown keeps link labels and code content', () => {
  assert.equal(stripInlineMarkdown('the [`schema`](a.md) field'), 'the schema field')
  assert.equal(stripInlineMarkdown('**bold** and _em_'), 'bold and em')
})

test('splitTarget separates path from fragment and decodes escapes', () => {
  assert.deepEqual(splitTarget('docs/a.md#some-heading'), { path: 'docs/a.md', fragment: 'some-heading' })
  assert.deepEqual(splitTarget('#local'), { path: '', fragment: 'local' })
  assert.deepEqual(splitTarget('docs/a.md'), { path: 'docs/a.md', fragment: undefined })
  assert.deepEqual(splitTarget('docs/a.md?x=1#f'), { path: 'docs/a.md', fragment: 'f' })
  assert.deepEqual(splitTarget('My%20File.md'), { path: 'My File.md', fragment: undefined })
  // A malformed escape must not throw; it stays raw so the gate reports it broken.
  assert.deepEqual(splitTarget('%zz.md'), { path: '%zz.md', fragment: undefined })
})

test('isExternalTarget excludes schemes, protocol-relative hosts, and root paths', () => {
  assert.ok(isExternalTarget('https://example.com/x'))
  assert.ok(isExternalTarget('mailto:a@b.c'))
  assert.ok(isExternalTarget('//cdn.example.com/x'))
  assert.ok(isExternalTarget('/docs/index.md'))
  assert.ok(!isExternalTarget('docs/index.md'))
  assert.ok(!isExternalTarget('#local'))
})

test('parseIndexRows reads the fixed table shape and skips its header', () => {
  const rows = parseIndexRows(
    ['| Topic | Home | Entry point |', '|---|---|---|', '| A subject | `docs/a.md` | [Section](a.md#section) |', ''].join('\n'),
  )
  assert.deepEqual(rows, [{ line: 3, topic: 'A subject', home: 'docs/a.md', linkUrl: 'a.md#section' }])
})

test('the index parser accepts CRLF and trailing spaces after the closing pipe', () => {
  const source = '| Topic | Home | Entry point |\r\n|---|---|---|\r\n| A subject | `docs/a.md` | [Section](a.md#section) |  \r\n'
  assert.deepEqual(parseIndexRows(source), [{ line: 3, topic: 'A subject', home: 'docs/a.md', linkUrl: 'a.md#section' }])
  assert.deepEqual(verifyIndexShape(source), [])
})

test('the index shape check rejects a fourth cell without a closing pipe', () => {
  const violations = verifyIndexShape('| Topic | Home | Entry point |\n|---|---|---|\n| Subject | `docs/a.md` | [A](a.md#section) | extra')
  assert.equal(violations.length, 1)
  assert.match(violations[0]?.detail ?? '', /4 cell/)
})

test('headingsOf ignores headings inside HTML comments', () => {
  const headings = headingsOf('# Proposal: x\n\n<!--\n## Risks\n-->\n\n## Problem\n')
  assert.deepEqual(headings.map(heading => heading.text), ['Proposal: x', 'Problem'])
})

test('the index shape check rejects extra cells, a missing home path, and a second link', () => {
  const source = ['| Topic | Home | Entry point |', '|---|---|---|', '| Four | `docs/a.md` | [A](a.md#section) | extra |', '| Bare | docs/a.md | [A](a.md#section) |', '| Two | `docs/a.md` | [A](a.md#section) [B](a.md#section) |'].join('\n')
  const violations = verifyIndexShape(source)
  assert.equal(violations.length, 3)
  assert.match(violations[0]?.detail ?? '', /4 cell/)
  assert.match(violations[1]?.detail ?? '', /backticked/)
  assert.match(violations[2]?.detail ?? '', /exactly one/)
})
test('proposal gate accepts the shipped proposal and rejects a missing status and section', () => {
  const result = verifyProposals()
  assert.equal(result.violations.length, 0, result.violations.map(v => v.detail).join('; '))
  assert.ok(result.checked >= 1)
  const invalid = verifyProposalSource('# Proposal: missing\n\n## Problem\n\n## Proposal\n\n## Decisions needed\n\n## Acceptance criteria\n\n## Risks\n', 'docs/proposals/invalid.md')
  assert.ok(invalid.some(item => item.detail.includes('Status')))
  const fenced = verifyProposalSource('# Proposal: fenced\n\n```text\nStatus: open\n```\n\n## Problem\n\n## Proposal\n\n## Decisions needed\n\n## Acceptance criteria\n\n## Risks\n', 'docs/proposals/fenced.md')
  assert.ok(fenced.some(item => item.detail.includes('Status')))
  const narrative = verifyProposalSource('# Proposal: narrative\n\nThe migration gate says\nStatus: open\n\n## Problem\n\n## Proposal\n\n## Decisions needed\n\n## Acceptance criteria\n\n## Risks\n', 'docs/proposals/narrative.md')
  assert.ok(narrative.some(item => item.detail.includes('Status')))
  const commented = verifyProposalSource('# Proposal: commented\n\nStatus: open\n\n## Problem\n\n## Proposal\n\n## Decisions needed\n\n## Acceptance criteria\n\n<!--\n## Risks\n-->\n', 'docs/proposals/commented.md')
  assert.ok(commented.some(item => item.detail.includes('Risks')))

})
