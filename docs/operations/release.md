---
kind: operations
description: How a release of the Action is cut and how consumers receive it.
---

# Releasing

The version is in [`.cz.toml`](../../.cz.toml). [Commitizen](https://commitizen-tools.github.io/commitizen/) bumps `VERSION`, `package.json`, `package-lock.json` and `CHANGELOG.md` from the Conventional Commits since the last tag.

```sh
pipx install commitizen
npm run commit        # write a commit in the project's format
npm run bump          # bump the version and the changelog
git push origin HEAD
git push origin "v$(cat VERSION)"
```

The tag needs its own push: commitizen creates lightweight tags, which `git push --follow-tags` does not push. A pushed `vX.Y.Z` tag runs [the release workflow](../../.github/workflows/release.yml): it opens a GitHub Release and moves the major tag (`v1.2.0` moves `v1`). Consumers pin the major tag, so a breaking change needs a new major version. To move a major tag back, run the release workflow by hand with the tag to point it at.
