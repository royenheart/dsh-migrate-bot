import { McpSettingsPage } from './McpSettingsPage.jsx'
import {
  MCP_RPC_CHANNEL,
  MCP_SETTINGS_NAMESPACE,
  McpSettingsController,
} from './settings-controller.js'
import { createSettingsApi } from './settings-api.js'
import { installMcpSettingsStyles } from './styles.js'

// `remote` rides the 0.1.2-rc.1+ settings write surface (see settings-api.js);
// it exists on every harness generation, while `connection.api` only on
// 0.1.1-rc.2, so both stay declared and the resolution happens at apply time.
// `remote.settings` deliberately stays UNDECLARED: on 0.1.2-rc.1 it is a
// mounted dotted service read through the inject-free `ctx.get`, and
// declaring it would park the plugin forever on 0.1.1-rc.2, where the
// namespace is never mounted.
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

export function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: MCP_SETTINGS_NAMESPACE })
  const describe = ctx.settingsScope.describe()
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi: createSettingsApi(ctx),
    rpc: (endpoint, payload, signal) =>
      ctx.connection.rpc.call(MCP_RPC_CHANNEL, endpoint, payload, signal),
  })

  ctx.effect(() => installMcpSettingsStyles(), 'mcp-adapter: Settings styles')
  ctx.effect(() => () => controller.dispose(), 'mcp-adapter: Settings controller')
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mcp',
        order: 30,
        label: 'MCP',
        inject: () => ({ controller }),
      },
      McpSettingsPage,
    ),
  )
}
