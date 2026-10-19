import { installMcpCommands } from './commands.js'
import { installMcpManager, installMcpManagerRpc } from './manager.js'
import { createMcpConnection } from './mcp-connection.js'
import { installMcpOauthCommands } from './oauth-commands.js'
import { createFileTokenStore } from './oauth.js'
import { installMcpOauth } from './oauth-service.js'
import { installMcpPromptCommand } from './prompt-commands.js'
import { installMcpPromotions } from './promotions.js'
import { installMcpProxyTool } from './proxy-tool.js'
import { installMcpSettings } from './settings.js'
import { installMcpSkill } from './skill.js'
import { installWorkspaceLayer } from './workspace-config.js'

export const name = 'dsh-mcp-adapter'

// Settings and Timer are optional at the Adapter row. The manager starts only
// while both Services exist, but the Config namespace can exist without Timer.
export const inject = []

export function apply(ctx) {
  // The bundled agent skill is independent of every other Adapter feature: a
  // deployment without the skills service simply gets no skill entry. Sibling
  // inject fibers run in registration order while the services exist, so the
  // settings callback reads `skillInstall` before the skills callback runs;
  // without the settings service the skill module's 'file' default applies.
  let skillInstall
  installMcpSettings(ctx, (settingsCtx, scope) => {
    skillInstall = scope.get()?.skillInstall
    const layeredScope = installWorkspaceLayer(settingsCtx, scope)
    settingsCtx.inject(['timer'], (managerCtx) => {
      const store = createFileTokenStore()
      let oauth
      const manager = installMcpManager(managerCtx, layeredScope, {
        connectionFactory: (serverName, config, callbacks, signal, sdk) =>
          createMcpConnection(serverName, config, callbacks, signal, sdk, {
            store,
            onAuthorizationRequired: (url) =>
              oauth?.noteAuthorizationRequired(serverName, url),
          }),
      })
      // The OAuth controller and every command read the LAYERED scope, so a
      // workspace-defined Server is signable and status-visible. Writes still
      // land in the global namespace: the layered scope forwards them there.
      oauth = installMcpOauth(managerCtx, manager, layeredScope, { store })
      managerCtx.inject(['connection'], (rpcCtx) => {
        installMcpManagerRpc(rpcCtx, manager, {
          // Refresh the workspace layer before each snapshot, giving the
          // Settings page poll a real refresh path for a file created after
          // startup.
          layerSnapshot: async () => {
            await layeredScope.refreshLayers()
            return layeredScope.layerSnapshot()
          },
          oauth,
        })
      })
      installMcpCommands(managerCtx, manager, layeredScope)
      installMcpOauthCommands(managerCtx, layeredScope, oauth)
      installMcpPromptCommand(managerCtx, manager)
      managerCtx.inject(['tools'], (toolCtx) => {
        installMcpProxyTool(toolCtx, manager)
        installMcpPromotions(toolCtx, manager, layeredScope)
      })
    })
  })
  ctx.inject(['skills'], (skillCtx) => installMcpSkill(skillCtx, { skillInstall }))
}

export * from './commands.js'
export * from './manager.js'
export * from './mcp-connection.js'
export * from './oauth-commands.js'
export * from './oauth-service.js'
export * from './oauth.js'
export * from './output-guard.js'
export * from './prompt-commands.js'
export * from './promotions.js'
export * from './proxy-tool.js'
export * from './settings.js'
export * from './skill.js'
export * from './workspace-config.js'
