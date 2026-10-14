import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const releaseTag = process.argv[2]
const expectedTag = `v${packageJson.version}`

if (releaseTag !== expectedTag) {
  console.error(
    `Release tag ${releaseTag ?? '(missing)'} does not match package version ${packageJson.version}`,
  )
  process.exitCode = 1
} else {
  console.log(
    `Release tag ${releaseTag} matches package version ${packageJson.version}`,
  )
}
