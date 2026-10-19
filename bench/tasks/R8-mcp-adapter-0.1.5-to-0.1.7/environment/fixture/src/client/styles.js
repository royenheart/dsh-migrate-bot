export const MCP_SETTINGS_CSS = `
.mcp-settings{width:100%;max-width:980px;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mcp-settings *{box-sizing:border-box}
.mcp-title{margin:0;font-size:16px;line-height:24px;font-weight:600}
.mcp-intro,.mcp-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mcp-toolbar,.mcp-actions,.mcp-row,.mcp-card-head{display:flex;align-items:center;gap:8px}
.mcp-toolbar{justify-content:space-between;flex-wrap:wrap}
.mcp-actions{flex-wrap:wrap}
.mcp-button{height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:transparent;color:var(--dsw-alias-label-primary);padding:0 13px;font:inherit;font-size:12px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.mcp-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mcp-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.mcp-button:disabled{cursor:not-allowed;opacity:.5}
.mcp-button-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mcp-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mcp-button-danger{color:var(--dsw-alias-state-error-primary)}
.mcp-button-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.mcp-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.mcp-error,.mcp-warning{border-radius:8px;padding:9px 11px;font-size:12px;line-height:18px}
.mcp-error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}
.mcp-warning{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.mcp-layout{display:grid;grid-template-columns:208px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.mcp-card,.mcp-empty{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.mcp-sidebar{display:flex;flex-direction:column;gap:2px;position:sticky;top:12px}
.mcp-server-button{width:100%;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 10px;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:8px;align-items:center;text-align:left;cursor:pointer;font:inherit;transition:background .12s ease,color .12s ease}
.mcp-server-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mcp-server-button[aria-current=true]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.mcp-server-name{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:500}
.mcp-server-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
.mcp-status-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex:none}
.mcp-status-connected{background:var(--dsw-alias-state-success-primary)}
.mcp-status-connecting{background:var(--dsw-alias-state-warn-primary)}
.mcp-status-dot.mcp-status-connecting{animation:mcp-pulse 1.2s ease-in-out infinite}
@keyframes mcp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.mcp-status-error{background:var(--dsw-alias-state-error-primary)}
.mcp-status-disabled{background:var(--dsw-alias-label-dimmed)}
.mcp-card{padding:16px;display:flex;flex-direction:column;gap:14px;min-width:0}
.mcp-card-head{align-items:flex-start;flex-wrap:wrap}
.mcp-card-head > div:first-child{flex:1 1 200px;min-width:0}
.mcp-card-title{margin:0;font-size:15px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.mcp-card-head .mcp-actions{margin-left:auto;justify-content:flex-end;flex:none}
.mcp-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 7px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;background:transparent}
.mcp-badge.mcp-status-connected{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent);background:transparent}
.mcp-badge.mcp-status-connecting{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);background:transparent}
.mcp-badge.mcp-status-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);background:transparent}
.mcp-badge.mcp-status-disabled{color:var(--dsw-alias-label-dimmed);background:transparent}
.mcp-badge-workspace{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);background:transparent}
.mcp-layer-notice{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);border-radius:8px;padding:9px 11px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mcp-form{display:flex;flex-direction:column;gap:12px}
.mcp-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.mcp-field-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.mcp-label{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:18px}
.mcp-input,.mcp-select,.mcp-textarea{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color .12s ease,background .12s ease}
.mcp-input,.mcp-select{height:34px;padding:0 10px}
.mcp-textarea{min-height:76px;padding:8px 10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.mcp-input:hover:not(:focus):not(:disabled),.mcp-select:hover:not(:focus):not(:disabled),.mcp-textarea:hover:not(:focus):not(:disabled){border-color:var(--dsw-alias-border-l3)}
.mcp-input:focus,.mcp-select:focus,.mcp-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.mcp-input:read-only{background:transparent;border-color:transparent;color:var(--dsw-alias-label-tertiary)}
.mcp-input::placeholder,.mcp-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.mcp-settings input[type=checkbox],.mcp-settings input[type=number]{accent-color:var(--dsw-alias-state-business-primary)}
.mcp-checkbox{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.mcp-checkbox input{margin-top:3px}
.mcp-section{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;display:flex;flex-direction:column;gap:9px}
.mcp-section-title{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mcp-secret-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto;gap:7px;align-items:center}
.mcp-secret-row > *{min-width:0}
.mcp-promotion-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto}
.mcp-promotion{border-radius:8px;padding:8px 10px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:9px;align-items:start;cursor:pointer;transition:background .12s ease}
.mcp-promotion:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mcp-promotion-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.mcp-promotion-description{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.mcp-empty{padding:30px 20px;text-align:center;display:flex;align-items:center;flex-direction:column;gap:10px}
.mcp-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);display:flex;align-items:center;justify-content:center;padding:20px;z-index:1200;animation:mcp-fade .12s ease}
.mcp-modal-card{width:min(560px,100%);max-height:min(760px,90vh);overflow:auto;padding:18px;display:flex;flex-direction:column;gap:13px;border:0;border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:mcp-pop .16s ease}
@keyframes mcp-fade{from{opacity:0}to{opacity:1}}
@keyframes mcp-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.mcp-modal-title{margin:0;font-size:15px;line-height:22px;font-weight:600}
.mcp-dialog-tabs{display:inline-flex;gap:2px;align-self:flex-start;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:2px;background:var(--dsw-alias-bg-layer-3)}
.mcp-dialog-tab{height:26px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .12s ease,color .12s ease}
.mcp-dialog-tab:hover:not(:disabled):not(.mcp-dialog-tab-active){color:var(--dsw-alias-label-primary)}
.mcp-dialog-tab:disabled{cursor:not-allowed;opacity:.5}
.mcp-dialog-tab-active{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mcp-dialog-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.mcp-confirm{border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
@container (max-width:660px){.mcp-layout{grid-template-columns:minmax(0,1fr)}.mcp-sidebar{position:static;flex-direction:row;overflow-x:auto;padding-bottom:2px}.mcp-server-button{width:auto;flex:none;white-space:nowrap}}
@container (max-width:480px){.mcp-field-row{grid-template-columns:minmax(0,1fr)}.mcp-secret-row{grid-template-columns:minmax(0,1fr) auto}.mcp-secret-row .mcp-input:first-child{grid-column:1 / -1}.mcp-card-head .mcp-actions{margin-left:0;width:100%}.mcp-toolbar{align-items:flex-start}}
`

export function installMcpSettingsStyles() {
  const id = 'dsh-mcp-adapter-settings'
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.pluginCss = id
  style.textContent = MCP_SETTINGS_CSS
  document.head.appendChild(style)
  return () => style.remove()
}
