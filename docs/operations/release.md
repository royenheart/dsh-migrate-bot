---
kind: operations
description: How a release of the Action is cut and how consumers receive it.
---

# Releasing

The version is in [`.cz.toml`](../../.cz.toml). [Commitizen](https://commitizen-tools.github.io/commitizen/) bumps `VERSION`, `package.json`, `package-lock.json`, the image tag in `action.yml`, the Action version the reusable workflow `.github/workflows/migrate.yml` runs and `CHANGELOG.md` from the Conventional Commits since the last tag. A breaking change bumps the major version, from `0.x` too, so consumers on the previous major tag keep the release they pinned.

```sh
pipx install commitizen
npm run commit        # write a commit in the project's format
npm run bump          # bump the version and the changelog
git push origin HEAD
git push origin "v$(cat VERSION)"
```

The tag needs its own push: commitizen creates lightweight tags, which `git push --follow-tags` does not push. A pushed `vX.Y.Z` tag runs [the release workflow](../../.github/workflows/release.yml): it builds the image, which fails when the agent runtime fails its self-test, pushes it to `ghcr.io/royenheart/dsh-migrate-bot:vX.Y.Z`, then moves the major tag (`v1.2.0` moves `v1`) and opens a GitHub Release. The image is pushed before the major tag moves, so a consumer never resolves a tag whose image does not exist. The package must be public for consumers to pull it. To move a major tag back, run the release workflow by hand with the tag to point it at.

## What a consumer pins

A consumer's workflow calls `royenheart/dsh-migrate-bot/.github/workflows/migrate.yml@v1`: the major tag, which moves to every release of that major version, so a breaking change needs a new major version. The major tag exists from the first final release of its version; until then, and to try a release candidate, a consumer pins the candidate's exact tag (`@v1.0.0-rc.1`), which never moves. Releases before 1.0.0 have no reusable workflow.

## A release candidate

A release candidate is tried on a few consumers before the major tag moves to it:

```sh
cz bump --changelog --prerelease rc --prerelease-offset 1   # 1.0.0-rc.1, then rc.2, …
git push origin HEAD
git push origin "v$(cat VERSION)"
```

A pushed `vX.Y.Z-rc.N` tag builds and pushes the image and opens a GitHub prerelease, and moves no major tag, so only a consumer that pins it runs it; the reusable workflow at that tag runs the Action of the same tag. The final release is bumped from the last candidate with `npm run bump`.

The `release` gate of `npm run gates` fails when `VERSION`, `package.json`, `package-lock.json`, `.cz.toml`, the image tag in `action.yml`, the Action version in `migrate.yml` and the newest release in `CHANGELOG.md` do not all state the same version.
