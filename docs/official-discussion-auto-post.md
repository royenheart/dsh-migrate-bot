# Future: auto-open official harness discussions

Status: **deferred**. The Action does not create topics on
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
When a migrate run still needs a dsh-side patch and no official issue / PR /
discussion exists, it writes a discussion draft, comments that draft on the
plugin Issue, then posts a follow-up comment with an Ideas “new discussion”
link. A human copies the draft and submits it.

This note records why unattended posting was sketched and then withdrawn, so
the work can be resumed without repeating the same design dead ends.

## What shipped instead

For each `.dsh-migrate/patch-reports/<slug>/report.md` that has **no** official
`deepseek-ai/deepseek-harness` issue / PR / discussion URL:

1. The main Issue comment still includes the index table and the fenced draft.
2. A second Issue comment (a follow-up under that draft) links to

   `https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=ideas&title=…`

The category is Ideas. The title is a best-effort query parameter. GitHub does
**not** document `title` / `body` on `discussions/new`, and `body=` does not
reliably fill the form. A full patch appendix would also exceed URL limits.
The follow-up therefore tells the reader to paste the draft from the previous
comment.

No extra secret or workflow permission is required. The built-in
`GITHUB_TOKEN` (plus **Allow GitHub Actions to create and approve pull
requests** on the plugin repo) is enough.

## What a future auto-post would do

If a later change opts in to creating the official topic automatically:

1. Keep today’s search-and-draft step. Do not open a topic when the report
   already cites an official issue / PR / discussion.
2. For each remaining draft, call GraphQL `createDiscussion` on
   `deepseek-ai/deepseek-harness`, category slug `ideas`.
3. Use the report’s first heading as the title and the report body as the
   body. Append the plugin Issue URL and companion PR URL.
4. Put the new discussion URL on the plugin Issue (table and/or follow-up)
   so maintainers can track it.

There is no public REST create endpoint; GraphQL is required
(`repositoryId`, `categoryId`, `title`, `body`).

## Why it is not enabled

`GITHUB_TOKEN` is minted for the **plugin** repository. It can open the
plugin Issue and PR. It cannot write Discussions on
`deepseek-ai/deepseek-harness`. Workflow `permissions:` and the “create and
approve pull requests” checkbox only affect that same plugin repo.

To create a discussion on the official public repo from CI, GitHub currently
requires a **classic PAT** with `public_repo` belonging to a user who may
start Ideas topics there. That scope can write every public repository the
account can write, not “discussions only.”

Narrower credentials do not reach a third-party repo:

| Credential | Why it fails here |
|---|---|
| Fine-grained PAT | Can only target repos the user owns or orgs that allow it. GitHub still excludes unaffiliated open-source write. `deepseek-ai/deepseek-harness` does not appear in the picker. |
| GitHub App installation token | Only works on repos where the app is installed. The official org would have to install it. |
| Plugin-repo `GITHUB_TOKEN` | Scoped to the plugin repo. |

A dedicated bot account plus a classic PAT would shrink blast radius (the bot
owns nothing else) but is still a classic PAT. That is an operational choice,
not a smaller GitHub permission.

## If this is revisited

- Keep auto-post **off** unless a consumer explicitly opts in.
- Do not recommend a personal classic PAT in plugin-repo secrets.
- Prefer an official-org GitHub App, or a locked-down bot account, if
  unattended posting is still required.
- Treat GraphQL failures as non-fatal: leave the draft and the Ideas link on
  the plugin Issue; do not fail the migrate.
- Deduplicate: never open a second topic when the report already has an
  official URL.
- After a successful create, write the URL back into the Issue comment so
  later runs classify the report as `existing`.
