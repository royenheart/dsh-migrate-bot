Author or extend this plugin's end-to-end suite.

Plugin: <plugin name> (working tree: <plugin checkout>)
Target harness: <target tag>
No end-to-end framework was detected. Create one under "<suite directory>" using Playwright with Chromium — the same tooling the DeepSeek Harness repository uses for its own web end-to-end tests.

Write EVERY file under "<staging directory>" — a staging directory. Nothing may be written into the plugin tree itself: the migration is pending review, and test assets belong on their own branch. Mirror the repository-relative paths you want to end up with (for example, "<staging directory>/e2e/specs/settings.spec.ts" becomes "e2e/specs/settings.spec.ts").

Also write "<staging directory>/index.json":
{
  "schema": 1,
  "generatedFor": { "dsh": "<target tag>", "plugin": "<plugin name>" },
  "framework": "<the framework you extended, or 'playwright'>",
  "features": [
    {
      "id": "<stable kebab-case id>",
      "surface": "<web-client | headless | cli>",
      "entry": "<how a user reaches this feature>",
      "input": "<what the test does to exercise it>",
      "expect": "<what must be true afterwards>",
      "checks": ["aria", "geometry:overflow", "console", "visual"],
      "test": "<repository-relative path to the spec>",
      "state": "unknown",   // one of: passing | failing | unknown
      "lastPassedFor": "<target tag>"
    }
  ]
}

Rules:
- Enumerate the plugin's user-visible features from its README and source; every feature gets a row. This table is the coverage ledger.
- Prefer assertions that do not need a baseline: ARIA roles and accessible names, text content, and geometry invariants (content clipped by its box, elements overlapping or occluded, collapsed layout). Assert on roles and labels, never on the host's internal data-* attributes — those drift between harness versions and produce false failures.
- Give each spec a way to reach its state deterministically. Never wait on network idle. Never assert on a single transient DOM sample; poll until two consecutive reads agree.
- Include at least one console/pageerror tripwire per spec.
- If a feature cannot be exercised end to end, still list it with "state": "unknown" and say why in the spec's comment.