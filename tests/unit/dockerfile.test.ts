import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLAYWRIGHT_VERSION } from '../../src/e2e/suite.ts'
import { appRootFrom } from '../../src/paths.ts'

const root = appRootFrom(import.meta.url)
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

test('the image ships a browser for the agent-authored end-to-end suite', () => {
  // Without this layer every E2E run fails at launch, and only at runtime.
  assert.match(dockerfile, /playwright install --with-deps chromium/)
  assert.match(dockerfile, /ENV PLAYWRIGHT_BROWSERS_PATH=/)
})

test('the suite pins the Playwright of the image, so its browser build is the one installed', () => {
  assert.equal(/npm install -g playwright@(\S+);/.exec(dockerfile)?.[1], PLAYWRIGHT_VERSION)
})

test('every slow or mirrored download is a build argument', () => {
  // GitHub runners reach the public mirrors; a local build in a filtered
  // network needs these to point elsewhere. Removing one strands those builds.
  for (const arg of ['DEBIAN_MIRROR', 'NPM_REGISTRY', 'PLAYWRIGHT_DOWNLOAD_HOST']) {
    assert.match(dockerfile, new RegExp(`^ARG ${arg}=`, 'm'), `${arg} must stay overridable`)
  }
})

test('the browser download honours its mirror argument', () => {
  assert.match(dockerfile, /if \[ -n "\$PLAYWRIGHT_DOWNLOAD_HOST" \]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi/)
})

test('the agent runtime is installed from its committed lockfile', () => {
  assert.match(dockerfile, /COPY container\/agent-runtime\/package\.json container\/agent-runtime\/package-lock\.json/)
  assert.match(dockerfile, /npm ci --omit=dev/)
  const lock = JSON.parse(readFileSync(join(root, 'container', 'agent-runtime', 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>
  }
  const manifest = JSON.parse(readFileSync(join(root, 'container', 'agent-runtime', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  // An exact version in the manifest and the same version in the lockfile:
  // a range here is what let a transitive release break every session.
  const declared = manifest.dependencies['@deepseek-ai/dsh']
  assert.match(declared ?? '', /^\d+\.\d+\.\d+(-[\w.]+)?$/)
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.version, declared)
})

test('the image is rejected when the agent runtime fails its self-test', () => {
  assert.match(dockerfile, /^RUN dsh-migrate self-test$/m)
})
