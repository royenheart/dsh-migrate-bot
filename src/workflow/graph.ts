import type { AnyStateNode } from 'xstate'
import { migrationMachine } from './machine.ts'

/**
 * The top-level statechart as Mermaid. The reference generator writes the same
 * shape into `docs/reference/workflow.md`; `inspect` uses this when a plugin
 * checkout does not carry that generated document.
 */
function name(node: AnyStateNode): string {
  return node.id.replace(/^migration\./, '')
}

function states(node: AnyStateNode): AnyStateNode[] {
  return Object.values(node.states).flatMap(child => [child, ...states(child)])
}

export function workflowDiagram(): string {
  const all = states(migrationMachine.root)
  const top = (node: AnyStateNode): string => name(node).split('.')[0] ?? ''
  const edges = new Set<string>()
  for (const node of all) {
    const outgoing = [...[...node.transitions.values()].flat(), ...(node.always ?? [])]
    for (const transition of outgoing) {
      for (const target of transition.target ?? []) {
        if (top(target) !== top(node)) edges.add(`  ${top(node)} --> ${top(target)}`)
      }
    }
  }
  const finals = Object.values(migrationMachine.root.states).filter(node => node.type === 'final').map(node => `  ${name(node)} --> [*]`)
  return ['stateDiagram-v2', '  [*] --> start', ...edges, ...finals].join('\n')
}
