/**
 * Gate: the workflow specification and the domain rules have no side effects.
 *
 * `src/workflow/` and `src/domain/` are the statechart, its model and the rules
 * it decides with; the property tests replay them without a file system, a
 * process or a network. A module there may import, at run time, only another
 * such module, one of `ALSO_PURE` (which are held to the same rule), and the
 * packages below. Type-only imports are free. Imports are read with the
 * TypeScript parser.
 */

import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { readText, REPO_ROOT } from './repo.ts'

const CORE = ['src/workflow', 'src/domain']
const ALSO_PURE = ['src/config/schema.ts', 'src/render/text.ts']
const PACKAGES = new Set(['xstate', 'zod', 'semver'])

export interface PurityViolation {
  file: string
  detail: string
}

/** The run-time imports of a module: every import that is not `import type`. */
export function runtimeImports(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return []
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return []
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly
    return typeOnly ? [] : [specifier.text]
  })
}

const isPure = (path: string): boolean => CORE.some(dir => path.startsWith(`${dir}/`)) || ALSO_PURE.includes(path)

export function checkModule(path: string, source: string): PurityViolation[] {
  return runtimeImports(source).flatMap((specifier) => {
    if (!specifier.startsWith('.')) return PACKAGES.has(specifier) ? [] : [{ file: path, detail: `imports the package ${specifier}` }]
    const target = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(path), specifier))
    return isPure(target) ? [] : [{ file: path, detail: `imports ${target}, which is not part of the pure core` }]
  })
}

export function verifyPureCore(): PurityViolation[] {
  const modules = [...CORE.flatMap(dir => readdirSync(join(REPO_ROOT, dir)).filter(name => name.endsWith('.ts')).map(name => `${dir}/${name}`)), ...ALSO_PURE]
  return modules.flatMap(path => checkModule(path, readText(join(REPO_ROOT, path))))
}
