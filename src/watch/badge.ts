/** shields.io endpoint badge payload. */
export interface ShieldsEndpoint {
  schemaVersion: 1
  label: string
  message: string
  color: string
}

export interface BadgeSource {
  verified?: { tag: string } | undefined
  pending?: { tag: string } | undefined
}

export const UNVERIFIED_BADGE: ShieldsEndpoint = {
  schemaVersion: 1,
  label: 'dsh',
  message: 'unverified',
  color: 'lightgrey',
}

/**
 * Default-branch support, not the watch cursor.
 * A merged or already-clean version wins; an open PR is `pending` only when
 * nothing has been verified yet.
 */
export function badgeFromSeenState(state: BadgeSource | undefined): ShieldsEndpoint {
  if (state?.verified !== undefined) {
    return {
      schemaVersion: 1,
      label: 'dsh',
      message: state.verified.tag,
      color: '0E7C66',
    }
  }
  if (state?.pending !== undefined) {
    return {
      schemaVersion: 1,
      label: 'dsh',
      message: 'pending',
      color: 'yellow',
    }
  }
  return UNVERIFIED_BADGE
}

export function serializeBadge(badge: ShieldsEndpoint): string {
  return `${JSON.stringify(badge, null, 2)}\n`
}
