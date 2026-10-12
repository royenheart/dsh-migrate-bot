import { COMMANDS_BY_VERB, COMMAND_PREFIX, renderCommandHelp, type CommandSpec } from './table.ts'

/**
 * Read a command out of a comment.
 *
 * A comment is prose that may contain a command, so the prefix is looked for
 * rather than required at the start, and everything outside it is ignored. What
 * comes back is a verb and its flags — never free-form text handed to an agent,
 * because a comment can be written by anyone who can see the repository and an
 * agent here holds an API key.
 */

export interface ParsedCommand {
  spec: CommandSpec
  flags: readonly string[]
}

export type ParseCommandResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; reason: string }

/**
 * Parse the first command in a comment body.
 * @param body - the comment text, prose included.
 */
export function parseCommand(body: string): ParseCommandResult {
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    const index = line.indexOf(COMMAND_PREFIX)
    if (index < 0) continue
    const rest = line.slice(index + COMMAND_PREFIX.length).trim()
    // The prefix alone, or followed by prose that is not a verb, is a request
    // for help rather than an error: a user who typed the bot's name gets the
    // vocabulary instead of silence.
    if (rest === '') return { ok: false, reason: 'help' }
    const parts = rest.split(/\s+/)
    const verb = parts[0] ?? ''
    const spec = COMMANDS_BY_VERB[verb]
    if (spec === undefined) {
      return { ok: false, reason: `\`${verb}\` is not a command.\n\n${renderCommandHelp()}` }
    }
    const flags: string[] = []
    for (const token of parts.slice(1)) {
      if (!token.startsWith('-')) {
        return { ok: false, reason: `\`${token}\` is not an argument \`${verb}\` accepts.\n\n${renderCommandHelp()}` }
      }
      if (!spec.flags.includes(token)) {
        return { ok: false, reason: `\`${verb}\` does not take \`${token}\`.\n\n${renderCommandHelp()}` }
      }
      flags.push(token)
    }
    return { ok: true, command: { spec, flags } }
  }
  return { ok: false, reason: 'no command' }
}

/**
 * Whether a commenter may run commands.
 *
 * GitHub's `author_association` is the cheap answer and covers the cases that
 * matter: the owner, a member of the owning organization, or a collaborator.
 * Anyone else is refused, and a bot is refused even when it is one of those,
 * because two bots answering each other is a loop rather than a conversation.
 * @param input.authorAssociation - the comment's `author_association`.
 * @param input.authorLogin - the commenter's login.
 * @param input.selfLogin - this Action's own bot login, when known.
 */
export function mayRunCommands(input: {
  authorAssociation: string | undefined
  authorLogin: string | undefined
  selfLogin?: string | undefined
}): boolean {
  const association = (input.authorAssociation ?? '').toUpperCase()
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association)) return false
  if (input.authorLogin !== undefined && input.authorLogin.endsWith('[bot]')) return false
  if (input.selfLogin !== undefined && input.authorLogin === input.selfLogin) return false
  return true
}
