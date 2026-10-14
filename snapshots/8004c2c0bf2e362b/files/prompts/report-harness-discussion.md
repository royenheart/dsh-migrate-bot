You are deciding whether a feature-request discussion draft should still be posted to the official DeepSeek Harness repository, or whether it has already been asked.

The draft was written during this migration's reviews and posted on the plugin's issue. Between then and the merge of the proposal, somebody may have opened the same request, or the maintainers may have shipped the change the draft asks for.

Decide one thing: is there already a thread that covers this draft?

- A thread covers it when the same change is being requested, or the same defect is being reported, even if the wording differs.
- A closed thread that never landed does **not** cover it: the request is still open, and a fresh topic is the right answer.
- A thread about a neighbouring API, a different package, or a coarser version of the request does **not** cover it.
- If the harness source for the target tag already ships the capability the draft asks for, the draft is obsolete rather than duplicated: say so in `reason` and leave `existing` empty.

You are given the draft, the candidate threads the Action already searched for, and the harness context. Judge from that evidence; do not treat a failed or empty search as proof that nothing exists, and say so in `reason` when the search was inconclusive.


Hard rules for this channel:
- This channel only classifies. Do not rewrite the draft, do not write a new one, and do not print a title or a body: the draft that gets posted is the one written during the migration.
- The draft sections are, in order: Title (`# [Feature request] …`), English summary (blockquote), Background, Current state, Proposal, Appendix: patch, Questions to confirm, Related.
- A candidate is only a duplicate when it requests the same change. Report the candidate URL verbatim; never construct a URL you were not given.

## What you receive

Everything you get is below. Do not search the network for more context, and do not modify the plugin repository: this session only writes a report.

<evidence of the merged proposal>

## Output contract

Print exactly one fenced ```json block as the last thing in your output, with this shape:

{
  "decisions": [
    {
      "slug": "<the patch report slug, exactly as given>",
      "post": true | false,
      "reason": "<one sentence>",
      "existing": [{ "url": "<existing thread>", "title": "<its title>", "why": "<one sentence>" }]
    }
  ]
}

Rules for that block:
- Exactly one decision per draft you were given, carrying that draft's slug verbatim.
- `post` is true only when no existing thread already requests the same thing and the request is still open. When it is false, `reason` says which of the two it is: an existing thread, or a request the harness already shipped.
- `existing` lists the threads that made this a duplicate, and is empty when there are none — including when the reason is "already shipped".
- Every URL in `existing` must be one you were given. Never construct one.
- Do not print anything after the block.
