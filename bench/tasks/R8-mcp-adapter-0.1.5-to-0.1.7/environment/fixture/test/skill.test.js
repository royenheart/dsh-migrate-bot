import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync as realReadFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { installMcpSkill, parseSkillFrontmatter, SKILL_DIR } from '../src/host/skill.js'

const DOC = [
  '---',
  'name: mcp-adapter',
  'description: Drive MCP Servers through the Adapter Proxy Tool.',
  'whenToUse: When a tool must come from an MCP Server.',
  '---',
  '',
  '# Using the MCP Adapter',
  '',
  'Search first.',
].join('\n')

const DIR = '/tmp/fake-skills/mcp-adapter/'

function fakeCtx() {
  const registered = []
  const warnings = []
  return {
    registered,
    warnings,
    skills: {
      register(skill) {
        registered.push(skill)
        return () => registered.pop()
      },
    },
    logger: { warn: (message) => warnings.push(message) },
  }
}

/** In-memory fs double exposing call records, with ENOENT for missing files. */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const calls = { mkdir: [], write: [], rename: [] }
  const missing = (path) => {
    const error = new Error(`no such file: ${path}`)
    error.code = 'ENOENT'
    throw error
  }
  return {
    files,
    calls,
    readFileSync: (path) => (files.has(path) ? files.get(path) : missing(path)),
    writeFileSync: (path, content) => {
      calls.write.push([path, content])
      files.set(path, content)
    },
    mkdirSync: (path, options) => calls.mkdir.push([path, options]),
    renameSync: (from, to) => {
      calls.rename.push([from, to])
      files.set(to, files.get(from))
      files.delete(from)
    },
  }
}

function fileOptions(fs, overrides = {}) {
  return {
    // The bundled source is read from the real package dir; only the
    // installed target goes through the in-memory fs.
    readFileSync: (path) => realReadFileSync(path, 'utf8'),
    readInstalledFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    env: { DSH_HOME: '/tmp/fake-home' },
    homedir: () => '/home/fake',
    ...overrides,
  }
}

const BUNDLED = realReadFileSync(`${SKILL_DIR}SKILL.md`, 'utf8')
const TARGET = '/tmp/fake-home/skills/mcp-adapter/SKILL.md'

test('parseSkillFrontmatter splits the frontmatter block from the body', () => {
  const parsed = parseSkillFrontmatter(DOC)
  assert.equal(parsed.name, 'mcp-adapter')
  assert.equal(parsed.description, 'Drive MCP Servers through the Adapter Proxy Tool.')
  assert.equal(parsed.whenToUse, 'When a tool must come from an MCP Server.')
  assert.equal(parsed.body.startsWith('# Using the MCP Adapter'), true)
  assert.equal(parsed.body.includes('Search first.'), true)
})

test('parseSkillFrontmatter rejects a file without a leading frontmatter block', () => {
  assert.throws(() => parseSkillFrontmatter('# Just a body\n'), /frontmatter/)
  assert.throws(() => parseSkillFrontmatter('text\n---\nname: x\n---\n'), /frontmatter/)
})

test('skillInstall runtime registers the bundled skill as a runtime skill', () => {
  const ctx = fakeCtx()
  const disposer = installMcpSkill(ctx, {
    readFileSync: () => DOC,
    dir: DIR,
    skillInstall: 'runtime',
  })
  assert.equal(ctx.registered.length, 1)
  const skill = ctx.registered[0]
  assert.equal(skill.name, 'mcp-adapter')
  assert.equal(skill.description, 'Drive MCP Servers through the Adapter Proxy Tool.')
  assert.equal(skill.whenToUse, 'When a tool must come from an MCP Server.')
  assert.equal(skill.source, 'runtime')
  assert.equal(skill.content.startsWith('# Using the MCP Adapter'), true)
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: DIR })
  disposer()
  assert.deepEqual(ctx.registered, [])
  assert.deepEqual(ctx.warnings, [])
})

test('installMcpSkill warns and registers nothing when the skill file is unreadable', () => {
  const ctx = fakeCtx()
  const result = installMcpSkill(ctx, {
    readFileSync: () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    },
    dir: DIR,
    skillInstall: 'runtime',
  })
  assert.equal(result, undefined)
  assert.deepEqual(ctx.registered, [])
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /bundled skill/)
})

test('installMcpSkill warns and registers nothing when frontmatter lacks required fields', () => {
  const ctx = fakeCtx()
  const result = installMcpSkill(ctx, {
    readFileSync: () => '---\nname: mcp-adapter\n---\n\n# Body',
    dir: DIR,
    skillInstall: 'runtime',
  })
  assert.equal(result, undefined)
  assert.deepEqual(ctx.registered, [])
  assert.equal(ctx.warnings.length, 1)
})

test('skillInstall file creates the directory and copies SKILL.md verbatim', () => {
  const fs = fakeFs()
  const ctx = fakeCtx()
  const result = installMcpSkill(ctx, fileOptions(fs))
  assert.equal(result, undefined, 'a file install returns no runtime disposer')
  assert.deepEqual(ctx.registered, [], 'one definition per name: no runtime registration')
  assert.deepEqual(ctx.warnings, [])
  assert.deepEqual(fs.calls.mkdir, [['/tmp/fake-home/skills/mcp-adapter', { recursive: true }]])
  const [tempPath, tempContent] = fs.calls.write[0]
  assert.equal(tempPath, '/tmp/fake-home/skills/mcp-adapter/.SKILL.md.tmp')
  assert.equal(tempContent, BUNDLED, 'the bundled file is copied byte for byte')
  assert.deepEqual(fs.calls.rename, [
    ['/tmp/fake-home/skills/mcp-adapter/.SKILL.md.tmp', TARGET],
  ])
  assert.equal(fs.files.get(TARGET), BUNDLED)
})

test('skillInstall file leaves an identical installed file untouched', () => {
  const fs = fakeFs({ [TARGET]: BUNDLED })
  const ctx = fakeCtx()
  installMcpSkill(ctx, fileOptions(fs))
  assert.deepEqual(fs.calls.write, [])
  assert.deepEqual(fs.calls.rename, [])
  assert.deepEqual(ctx.registered, [])
  assert.deepEqual(ctx.warnings, [])
})

test('skillInstall file keeps a human-edited installed file and warns once', () => {
  const edited = `${BUNDLED}\n\nHuman edit wins.\n`
  const fs = fakeFs({ [TARGET]: edited })
  const ctx = fakeCtx()
  installMcpSkill(ctx, fileOptions(fs))
  assert.equal(fs.files.get(TARGET), edited,
    'the installed file stays byte for byte unchanged')
  assert.deepEqual(fs.calls.write, [])
  assert.deepEqual(fs.calls.rename, [])
  assert.deepEqual(ctx.registered, [])
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /\/tmp\/fake-home\/skills\/mcp-adapter\/SKILL\.md/)
  assert.match(ctx.warnings[0], /dsh-mcp-adapter \d+\.\d+\.\d+/)
  assert.match(ctx.warnings[0], /delete/)
})

test('skillInstall file falls back to runtime registration when the write fails', () => {
  const fs = fakeFs()
  fs.writeFileSync = () => {
    const error = new Error('read-only file system')
    error.code = 'EROFS'
    throw error
  }
  const ctx = fakeCtx()
  installMcpSkill(ctx, fileOptions(fs))
  assert.equal(ctx.registered.length, 1, 'the runtime fallback registers the skill')
  assert.equal(ctx.registered[0].source, 'runtime')
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /cannot install the skill file/)
  assert.match(ctx.warnings[0], /read-only file system/)
})

test('skillInstall file falls back to runtime registration when the installed file is unreadable', () => {
  const fs = fakeFs()
  fs.readFileSync = () => {
    const error = new Error('permission denied')
    error.code = 'EACCES'
    throw error
  }
  const ctx = fakeCtx()
  installMcpSkill(ctx, fileOptions(fs))
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /cannot read the installed skill file/)
})

test('skillInstall runtime and off never touch the filesystem', () => {
  for (const mode of ['runtime', 'off']) {
    const fs = fakeFs()
    const ctx = fakeCtx()
    installMcpSkill(ctx, fileOptions(fs, { skillInstall: mode }))
    assert.deepEqual(fs.calls.mkdir, [], `${mode} must not mkdir`)
    assert.deepEqual(fs.calls.write, [], `${mode} must not write`)
    assert.deepEqual(fs.calls.rename, [], `${mode} must not rename`)
    if (mode === 'runtime') assert.equal(ctx.registered.length, 1)
    else assert.deepEqual(ctx.registered, [], 'off installs nothing')
    assert.deepEqual(ctx.warnings, [])
  }
})

test('the DSH_HOME override and the homedir fallback both shape the target path', () => {
  const viaEnv = fakeFs()
  installMcpSkill(fakeCtx(), fileOptions(viaEnv))
  assert.match(viaEnv.calls.rename[0][1], /^\/tmp\/fake-home\/skills\/mcp-adapter\/SKILL\.md$/)

  const viaHomedir = fakeFs()
  installMcpSkill(fakeCtx(), {
    readFileSync: (path) => realReadFileSync(path, 'utf8'),
    readInstalledFileSync: viaHomedir.readFileSync,
    writeFileSync: viaHomedir.writeFileSync,
    mkdirSync: viaHomedir.mkdirSync,
    renameSync: viaHomedir.renameSync,
    env: {},
    homedir: () => '/home/someone',
  })
  assert.match(viaHomedir.calls.rename[0][1], /^\/home\/someone\/\.dsh\/skills\/mcp-adapter\/SKILL\.md$/)
})

test('the bundled SKILL.md is well-formed and teaches the Proxy Tool workflow', () => {
  const ctx = fakeCtx()
  const disposer = installMcpSkill(ctx, {
    readFileSync: realReadFileSync,
    dir: SKILL_DIR,
    skillInstall: 'runtime',
  })
  assert.equal(ctx.registered.length, 1, 'the real skill file registers against the real disk')

  const skill = ctx.registered[0]
  assert.equal(SKILL_DIR.endsWith('skills/mcp-adapter/'), true)
  assert.equal(skill.name, 'mcp-adapter')
  assert.match(skill.name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  assert.ok(skill.description.length > 0)
  assert.equal(skill.source, 'runtime')
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: SKILL_DIR })
  for (const marker of ['action: "search"', 'action: "describe"', 'action: "call"', 'OAuth authorization required', '/mcp-auth']) {
    assert.equal(
      skill.content.includes(marker),
      true,
      `the skill body must teach ${JSON.stringify(marker)}`,
    )
  }
  assert.equal(typeof disposer, 'function')
})

test('a real file install lands in $DSH_HOME/skills and repeats idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-skill-'))
  const bundled = realReadFileSync(`${SKILL_DIR}SKILL.md`, 'utf8')
  try {
    const ctx = fakeCtx()
    installMcpSkill(ctx, { env: { DSH_HOME: home }, homedir: () => '/home/unused' })
    const installed = join(home, 'skills', 'mcp-adapter', 'SKILL.md')
    const stats = realReadFileSync(installed, 'utf8')
    assert.equal(stats, bundled)

    const second = fakeCtx()
    installMcpSkill(second, { env: { DSH_HOME: home }, homedir: () => '/home/unused' })
    assert.deepEqual(second.registered, [], 'the second start does not register a duplicate')
    assert.deepEqual(second.warnings, [], 'an identical installed file is silent')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
