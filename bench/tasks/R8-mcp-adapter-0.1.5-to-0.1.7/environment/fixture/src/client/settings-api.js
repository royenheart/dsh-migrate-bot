/**
 * Resolve the Settings write face across DSH harness generations.
 *
 * DSH 0.1.2-rc.1 removed the `connection` service's `api` face, moving the
 * settings write surface onto the `remote` service (its `settings` namespace is
 * mounted by the @deepseek-ai/dsh-api-remotes client bundle). The new face
 * takes positional `(ns, patch | ops, expectedRevision)` arguments and answers
 * a flat `{ ok, value | error }` envelope. DSH 0.1.1-rc.2 keeps the write
 * surface on `connection.api.settings`, with one request-object argument and a
 * `{ result: { ok, value | error } }` envelope.
 *
 * Both faces normalize to the controller's contract: `update` and `mutate`
 * take one request object and answer `{ result: { ok, value, error } }`, so
 * callers stay unaware of which harness generation is running. Prefer the
 * `remote` face when it exists: it is the only one DSH 0.1.2-rc.1 provides.
 */
export function createSettingsApi(ctx) {
  const remoteSettings = readRemoteSettings(ctx)
  if (remoteSettings !== undefined) return remoteSettingsApi(remoteSettings)

  const connectionSettings = ctx.connection?.api?.settings
  if (connectionSettings !== undefined) return connectionSettings

  throw new Error(
    'No DSH settings write API: expected ctx.remote.settings (DSH 0.1.2+) '
    + 'or ctx.connection.api.settings (DSH 0.1.1-rc.2). Upgrade '
    + '@auggieteo/dsh-mcp-adapter to a release supporting this harness.',
  )
}

/**
 * Read the mounted `remote.settings` namespace across generations without
 * declaring it in `inject`.
 *
 * On DSH 0.1.2-rc.1 the namespace is a traced dotted service: reading it as
 * `ctx.remote.settings` makes cordis compose the `remote.settings` key and
 * throw `cannot get property "remote.settings" without inject` unless the
 * plugin declares that exact service. It must stay undeclared anyway — on
 * 0.1.1-rc.2 the namespace is never mounted, and a declared-but-missing
 * service keeps the plugin fiber from ever applying. `ctx.get` is cordis's
 * documented inject-free read: on 0.1.2-rc.1 it resolves the mounted
 * namespace through the root isolate; on 0.1.1-rc.2 it answers undefined,
 * leaving the `connection.api.settings` fallback reachable. The direct
 * `ctx.remote?.settings` read stays as the fallback for runner generations
 * that expose the face as a plain property (and for test doubles).
 */
function readRemoteSettings(ctx) {
  if (typeof ctx.get === 'function') {
    try {
      const mounted = ctx.get('remote.settings')
      if (mounted !== undefined) return mounted
    } catch { /* fall through to the direct read */ }
  }
  try {
    return ctx.remote?.settings
  } catch { /* the governed dotted read on 0.1.2-rc.1 — ctx.get already covered it */ }
  return undefined
}

/** Wrap the 0.1.2-rc.1 `remote.settings` face in the controller's contract. */
function remoteSettingsApi(remote) {
  return {
    async update({ ns, patch, expectedRevision }) {
      return { result: await remote.update(ns, patch, expectedRevision) }
    },
    async mutate({ ns, ops, expectedRevision }) {
      return { result: await remote.mutate(ns, ops, expectedRevision) }
    },
  }
}
