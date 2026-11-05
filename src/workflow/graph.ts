import type { AnyStateNode } from 'xstate'
import { migrationMachine } from './machine.ts'

/**
 * The top-level statechart as Mermaid and as a node/edge inventory. The
 * reference generator writes the diagram; `inspect` uses the inventory to
 * diff nodes even when a recorded Mermaid graph has no edge that names one.
 */
function name(node: AnyStateNode): string {
  return node.id.replace(/^migration\./, '')
}

function states(node: AnyStateNode): AnyStateNode[] {
  return Object.values(node.states).flatMap(child => [child, ...states(child)])
}

const top = (node: AnyStateNode): string => name(node).split('.')[0] ?? ''

export interface WorkflowInventory {
  nodes: string[]
  edges: string[]
}

export function workflowInventory(): WorkflowInventory {
  const all = states(migrationMachine.root)
  const nodes = new Set<string>()
  const edges = new Set<string>(['[*] --> start'])
  for (const node of all) {
    nodes.add(top(node))
    const outgoing = [...[...node.transitions.values()].flat(), ...(node.always ?? [])]
    for (const transition of outgoing) {
      for (const target of transition.target ?? []) {
        if (top(target) !== top(node)) edges.add(`${top(node)} --> ${top(target)}`)
      }
    }
  }
  for (const node of Object.values(migrationMachine.root.states).filter(child => child.type === 'final')) {
    nodes.add(name(node))
    edges.add(`${name(node)} --> [*]`)
  }
  return { nodes: [...nodes], edges: [...edges] }
}

export function workflowDiagram(): string {
  const { edges } = workflowInventory()
  return ['stateDiagram-v2', ...edges.map(edge => `  ${edge}`)].join('\n')
}
