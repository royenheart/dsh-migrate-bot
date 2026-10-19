import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { newest, parseRelease, TAG_PREFIX } from '../domain/release.ts'
import type { Release } from '../workflow/model.ts'

/**
 * Resolve the target release.
 *
 * `latest` is the newest `dsh-v*` tag of the harness repository by semver
 * order, read with `git ls-remote`, which needs no token and shares no API rate
 * limit. Anything else must name one release.
 */

export const HARNESS_REPOSITORY_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const run = promisify(execFile)

/** Tag names of a remote repository. */
export async function listRemoteTags(url: string): Promise<string[]> {
  const { stdout } = await run('git', ['ls-remote', '--tags', '--refs', url, `${TAG_PREFIX}*`], { timeout: 60_000 })
  return stdout.split('\n').map(line => line.split('refs/tags/')[1] ?? '').filter(tag => tag !== '')
}

/**
 * @param requested - `latest`, a version, or a `dsh-v*` tag.
 * @param listTags - the tag lister, injectable for tests.
 */
export async function resolveTarget(requested: string, listTags: (url: string) => Promise<string[]> = listRemoteTags): Promise<Release> {
  if (requested !== 'latest') {
    const release = parseRelease(requested)
    if (release === undefined) throw new Error(`target \`${requested}\` is not \`latest\`, a version, or a ${TAG_PREFIX}* tag`)
    return release
  }
  const releases = (await listTags(HARNESS_REPOSITORY_URL)).flatMap(tag => parseRelease(tag) ?? [])
  const latest = newest(releases)
  if (latest === undefined) throw new Error(`no ${TAG_PREFIX}* tag in ${HARNESS_REPOSITORY_URL}`)
  return latest
}
