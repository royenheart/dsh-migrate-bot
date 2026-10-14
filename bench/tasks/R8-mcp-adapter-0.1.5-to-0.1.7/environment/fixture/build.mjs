// Builds the client bundle at lib/client.js in the shape the DSH client
// module loader expects: window.__ModuleLoader__.load({id, factory}), where
// factory(require) returns module.exports (named exports apply/inject).
// `node build.mjs --watch` keeps rebuilding so dsh-client-hmr reloads the page.

import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const banner = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkg.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')

const footer = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

const options = {
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  // The client module loader provides these at runtime (externals table).
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  outfile: 'lib/client.js',
  sourcemap: true,
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[dsh-mcp-adapter] watching for client rebuilds')
} else {
  await build(options)
}
