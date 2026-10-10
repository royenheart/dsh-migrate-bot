---
kind: operations
description: How a release of the Action is cut and how consumers receive it.
---

# Releasing

The version is in [`.cz.toml`](../../.cz.toml). [Commitizen](https://commitizen-tools.github.io/commitizen/) bumps `VERSION`, `package.json`, `package-lock.json`, the image tag in `action.yml` and `CHANGELOG.md` from the Conventional Commits since the last tag. A breaking change bumps the major version, from `0.x` too, so consumers on the previous major tag keep the release they pinned.

```sh
pipx install commitizen
npm run commit        # write a commit in the project's format
npm run bump          # bump the version and the changelog
git push origin HEAD
git push origin "v$(cat VERSION)"
```

The tag needs its own push: commitizen creates lightweight tags, which `git push --follow-tags` does not push. A pushed `vX.Y.Z` tag runs [the release workflow](../../.github/workflows/release.yml): it builds the image, which fails when the agent runtime fails its self-test, pushes it to `ghcr.io/royenheart/dsh-migrate-bot:vX.Y.Z`, then moves the major tag (`v1.2.0` moves `v1`) and opens a GitHub Release. The image is pushed before the major tag moves, so a consumer never resolves a tag whose image does not exist. The package must be public for consumers to pull it. Consumers pin the major tag, so a breaking change needs a new major version. To move a major tag back, run the release workflow by hand with the tag to point it at.

The `release` gate of `npm run gates` fails when `VERSION`, `package.json`, `package-lock.json`, `.cz.toml`, the image tag in `action.yml` and the newest release in `CHANGELOG.md` do not all state the same version.
