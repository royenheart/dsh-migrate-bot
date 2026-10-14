import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import {
  normalizeServerConfig,
  parseArgs,
  parseMcpImport,
  parseScopes,
  secretKeysFromView,
  secretRowOps,
  serverSource,
} from './settings-controller.js'

function statusFor(overview, name) {
  return overview.status.servers.find((entry) => entry.name === name) ?? {
    name,
    state: 'disconnected',
    toolCount: 0,
  }
}

function catalogFor(overview, name) {
  return overview.catalog.servers.find((entry) => entry.name === name)?.tools ?? []
}

function statusClass(state) {
  if (state === 'connected') return 'mcp-status-connected'
  if (state === 'connecting') return 'mcp-status-connecting'
  if (state === 'error') return 'mcp-status-error'
  if (state === 'disabled') return 'mcp-status-disabled'
  return ''
}

function secretRows(keys) {
  return keys.map((key) => ({ originalKey: key, key, value: '' }))
}

function SecretEditor({ field, rows, onChange, disabled }) {
  const label = field === 'env' ? 'Environment variables' : 'HTTP headers'
  const add = () => onChange([...rows, { key: '', value: '' }])
  const update = (index, patch) => {
    onChange(rows.map((row, position) => position === index ? { ...row, ...patch } : row))
  }
  const remove = (index) => onChange(rows.filter((_, position) => position !== index))

  return (
    <div className="mcp-section">
      <div>
        <h4 className="mcp-section-title">{label}</h4>
        <p className="mcp-muted">
          Existing secret values stay saved when their value field remains blank.
        </p>
      </div>
      {rows.map((row, index) => (
        <div className="mcp-secret-row" key={`${row.originalKey ?? 'new'}-${index}`}>
          <input
            className="mcp-input"
            aria-label={`${label} key ${index + 1}`}
            placeholder={field === 'env' ? 'API_TOKEN' : 'Authorization'}
            value={row.key}
            disabled={disabled}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className="mcp-input"
            aria-label={`${label} value ${index + 1}`}
            type={field === 'env' ? 'password' : 'text'}
            autoComplete="off"
            placeholder={row.originalKey === undefined ? 'Value' : 'Saved value'}
            value={row.value}
            disabled={disabled}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="mcp-button mcp-button-danger"
            disabled={disabled}
            onClick={() => remove(index)}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="mcp-button" disabled={disabled} onClick={add}>
          Add {field === 'env' ? 'variable' : 'header'}
        </button>
      </div>
    </div>
  )
}

function useEscapeClose(onClose) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

/**
 * The single entry point for adding Servers: an Input fields mode for one
 * Server, or a Paste JSON mode for a standard `mcpServers` object.
 */
function AddServerDialog({ controller, busy, onClose }) {
  const [mode, setMode] = useState('form')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('stdio')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [argsText, setArgsText] = useState('[]')
  const [auth, setAuth] = useState('headers')
  const [scopesText, setScopesText] = useState('')
  const [jsonText, setJsonText] = useState('{\n  "mcpServers": {\n    \n  }\n}')
  const [error, setError] = useState()
  useEscapeClose(onClose)
  const switchMode = (next) => {
    setMode(next)
    setError(undefined)
  }
  const submit = async (event) => {
    event.preventDefault()
    setError(undefined)
    if (mode === 'json') {
      try {
        parseMcpImport(jsonText)
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError))
        return
      }
      const result = await controller.importJson(jsonText)
      if (result) onClose()
      else setError('The Host rejected this import. Review the page error and retry.')
      return
    }
    let config
    try {
      config = normalizeServerConfig(
        name,
        transport === 'stdio'
          ? { command, args: parseArgs(argsText) }
          : { url, auth, scopes: auth === 'oauth' ? parseScopes(scopesText) : [] },
      )
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
      return
    }
    if (await controller.addServer(name, config)) onClose()
  }

  return (
    <div className="mcp-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <form className="mcp-modal-card" aria-label="Add MCP Server" onSubmit={submit}>
        <div className="mcp-card-head">
          <div>
            <h3 className="mcp-modal-title">Add Server</h3>
            <p className="mcp-muted">Fill in the fields for one Server, or paste an mcpServers JSON.</p>
          </div>
          <button type="button" className="mcp-button" onClick={onClose}>Close</button>
        </div>
        <div className="mcp-dialog-tabs" role="tablist" aria-label="Add Server input mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'form'}
            className={mode === 'form' ? 'mcp-dialog-tab mcp-dialog-tab-active' : 'mcp-dialog-tab'}
            disabled={busy}
            onClick={() => switchMode('form')}
          >
            Input fields
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'json'}
            className={mode === 'json' ? 'mcp-dialog-tab mcp-dialog-tab-active' : 'mcp-dialog-tab'}
            disabled={busy}
            onClick={() => switchMode('json')}
          >
            Paste JSON
          </button>
        </div>
        {error !== undefined && <div className="mcp-error" role="alert">{error}</div>}
        {mode === 'json' && (
          <label className="mcp-field">
            <span className="mcp-label">MCP Config JSON</span>
            <textarea
              autoFocus
              className="mcp-textarea"
              style={{ minHeight: 280 }}
              value={jsonText}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setJsonText(event.target.value)}
            />
            <span className="mcp-muted">
              One or more Servers. A name that already exists is replaced.
            </span>
          </label>
        )}
        {mode === 'form' && (
          <>
        <label className="mcp-field">
          <span className="mcp-label">Name</span>
          <input
            autoFocus
            className="mcp-input"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="github"
          />
        </label>
        <label className="mcp-field">
          <span className="mcp-label">Transport</span>
          <select
            className="mcp-select"
            value={transport}
            disabled={busy}
            onChange={(event) => setTransport(event.target.value)}
          >
            <option value="stdio">stdio</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className="mcp-field">
              <span className="mcp-label">Command</span>
              <input
                className="mcp-input"
                value={command}
                disabled={busy}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx"
              />
            </label>
            <label className="mcp-field">
              <span className="mcp-label">Args as a JSON array</span>
              <textarea
                className="mcp-textarea"
                value={argsText}
                disabled={busy}
                placeholder={'["-y", "@modelcontextprotocol/server-github"]'}
                onChange={(event) => setArgsText(event.target.value)}
                spellCheck={false}
              />
            </label>
          </>
        ) : (
          <>
            <label className="mcp-field">
              <span className="mcp-label">URL</span>
              <input
                className="mcp-input"
                value={url}
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
            <div className="mcp-field-row">
              <label className="mcp-field">
                <span className="mcp-label">HTTP authentication</span>
                <select
                  className="mcp-select"
                  value={auth}
                  disabled={busy}
                  title="Static headers send fixed values on every request. OAuth 2.0 with PKCE signs in through the provider in your browser."
                  onChange={(event) => setAuth(event.target.value)}
                >
                  <option value="headers">Static headers</option>
                  <option value="oauth">OAuth 2.0 with PKCE</option>
                </select>
              </label>
              {auth === 'oauth' && (
                <label className="mcp-field">
                  <span className="mcp-label">OAuth scopes (optional, comma-separated)</span>
                  <input
                    className="mcp-input"
                    value={scopesText}
                    disabled={busy}
                    placeholder="read write"
                    title="Optional. Leave empty when the provider defines no scopes — for example Context7. Request only scopes the provider grants."
                    onChange={(event) => setScopesText(event.target.value)}
                  />
                  <span className="mcp-muted">Leave empty unless the provider requires scopes.</span>
                </label>
              )}
            </div>
            {auth === 'oauth' && (
              <p className="mcp-muted">
                OAuth signs in through your browser. The Sign in button appears
                on the Server panel after you save.
              </p>
            )}
          </>
        )}
        </>
        )}
        <div className="mcp-actions">
          <button type="submit" className="mcp-button mcp-button-primary" disabled={busy}>
            {busy
              ? mode === 'json' ? 'Importing…' : 'Adding…'
              : mode === 'json' ? 'Import Servers' : 'Add Server'}
          </button>
          <button type="button" className="mcp-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * OAuth sign-in/sign-out section, shared by the editable detail and the
 * read-only workspace detail. Sign-in works for workspace-defined Servers
 * too: the Adapter resolves the Server through the merged Config.
 */
function OAuthSection({ controller, snapshot, name }) {
  const oauthStatus = snapshot.oauthStatuses?.[name]
  const oauthSignedIn =
    oauthStatus !== undefined &&
    oauthStatus.signedIn === true &&
    (oauthStatus.expiresAt === undefined || oauthStatus.expiresAt > Date.now())
  const oauthState = oauthStatus?.configured
    ? oauthSignedIn
      ? 'Signed in'
      : oauthStatus.expiresAt !== undefined
        ? 'Signed out (token expired)'
        : 'Signed out'
    : 'Signed out'
  const signIn = async () => {
    const result = await controller.signIn(name)
    if (result?.authorizationUrl) window.open(result.authorizationUrl, '_blank')
  }

  return (
    <div className="mcp-section">
      <div>
        <h3 className="mcp-section-title">OAuth</h3>
        <p className="mcp-muted">
          OAuth 2.0 with PKCE. {oauthState}. Sign-in opens the authorization
          page in your browser; the Adapter completes the flow in the
          background and reconnects with the fresh tokens. If no tab opens,
          allow pop-ups for this page or run /mcp-auth.
        </p>
        {oauthStatus !== undefined && oauthStatus.configured === true && !oauthSignedIn && (
          <div className="mcp-warning">This Server cannot connect until you sign in.</div>
        )}
      </div>
      <div className="mcp-actions">
        <button
          type="button"
          className="mcp-button mcp-button-primary"
          disabled={snapshot.busy}
          title="Opens the provider's authorization page in a new browser tab. The Adapter finishes the flow in the background and reconnects."
          onClick={() => void signIn()}
        >
          Sign in
        </button>
        <button
          type="button"
          className="mcp-button"
          disabled={snapshot.busy}
          title="Deletes the stored tokens and disconnects this Server."
          onClick={() => void controller.signOut(name)}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/**
 * Read-only detail for a Server defined only in the workspace `.dsh/mcp.json`.
 * Edits write the global Config layer, which the workspace file overrides, so
 * the panel shows the sanitized workspace Config and, for OAuth Servers, the
 * sign-in actions.
 */
function WorkspaceServerDetail({ controller, snapshot, name, server }) {
  const status = statusFor(snapshot.overview, name)
  return (
    <div className="mcp-card">
      <div className="mcp-card-head">
        <div>
          <div className="mcp-row">
            <span className={`mcp-status-dot ${statusClass(status.state)}`} />
            <h2 className="mcp-card-title">{name}</h2>
            <span className={`mcp-badge ${statusClass(status.state)}`}>{status.state}</span>
            <span className="mcp-badge mcp-badge-workspace">workspace</span>
          </div>
          <p className="mcp-muted">
            {status.toolCount} {status.toolCount === 1 ? 'tool' : 'tools'} cached
            {status.transport === undefined ? '' : ` · ${status.transport}`}
          </p>
        </div>
      </div>
      <div className="mcp-layer-notice">
        Read-only: defined by the workspace .dsh/mcp.json file. Edit that file
        to change this Server.
      </div>
      <div className="mcp-section">
        <h3 className="mcp-section-title">Config</h3>
        <p className="mcp-muted">
          {typeof server.command === 'string'
            ? `stdio: ${server.command}${(server.args ?? []).length > 0 ? ` ${server.args.join(' ')}` : ''}`
            : `HTTP: ${server.url}`}{' '}
          · lifecycle {server.lifecycle ?? 'lazy'} · {server.autoAllow ? 'auto-allow' : 'asks per call'}
        </p>
      </div>
      {typeof server.url === 'string' && server.auth === 'oauth' && (
        <OAuthSection controller={controller} snapshot={snapshot} name={name} />
      )}
      <div className="mcp-section">
        <h3 className="mcp-section-title">Promotions</h3>
        <p className="mcp-muted">
          Promotions for a workspace Server are managed in the workspace file
          through its promotedTools list.
        </p>
      </div>
    </div>
  )
}

function ServerDetail({ controller, snapshot, name, server }) {
  const status = statusFor(snapshot.overview, name)
  const tools = catalogFor(snapshot.overview, name)
  const workspaceSourced = serverSource(snapshot.layers, name) === 'workspace'
  const transport = typeof server.command === 'string' ? 'stdio' : 'http'
  const [draft, setDraft] = useState(() => ({
    transport,
    command: server.command ?? '',
    url: server.url ?? '',
    argsText: JSON.stringify(server.args ?? [], null, 2),
    auth: server.auth ?? 'headers',
    scopesText: (server.scopes ?? []).join(', '),
    disabled: server.disabled === true,
    autoAllow: server.autoAllow === true,
    idleTimeoutMinutes: String(server.idleTimeoutMinutes ?? 10),
  }))
  const [rowSets, setRowSets] = useState(() => ({
    env: secretRows(secretKeysFromView(snapshot.settingsDocument.view, name, 'env')),
    headers: secretRows(secretKeysFromView(snapshot.settingsDocument.view, name, 'headers')),
  }))
  const activeSecretField = draft.transport === 'stdio' ? 'env' : 'headers'
  const rows = rowSets[activeSecretField]
  const [dirty, setDirty] = useState(false)
  const [formError, setFormError] = useState()
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (dirty) return
    const nextTransport = typeof server.command === 'string' ? 'stdio' : 'http'
    setDraft({
      transport: nextTransport,
      command: server.command ?? '',
      url: server.url ?? '',
      argsText: JSON.stringify(server.args ?? [], null, 2),
      auth: server.auth ?? 'headers',
      scopesText: (server.scopes ?? []).join(', '),
      disabled: server.disabled === true,
      autoAllow: server.autoAllow === true,
      idleTimeoutMinutes: String(server.idleTimeoutMinutes ?? 10),
    })
    setRowSets({
      env: secretRows(secretKeysFromView(snapshot.settingsDocument.view, name, 'env')),
      headers: secretRows(secretKeysFromView(snapshot.settingsDocument.view, name, 'headers')),
    })
  }, [dirty, name, server, snapshot.settingsDocument.view])

  const changeDraft = (patch) => {
    setDirty(true)
    setDraft((current) => ({ ...current, ...patch }))
  }
  const changeRows = (next) => {
    setDirty(true)
    setRowSets((current) => ({ ...current, [activeSecretField]: next }))
  }
  const save = async (event) => {
    event.preventDefault()
    setFormError(undefined)
    try {
      const nextTransport = draft.transport
      normalizeServerConfig(name, {
        ...(nextTransport === 'stdio'
          ? { command: draft.command, args: parseArgs(draft.argsText) }
          : { url: draft.url }),
        auth: nextTransport === 'http' ? draft.auth : 'headers',
        scopes: nextTransport === 'http' ? parseScopes(draft.scopesText) : [],
        disabled: draft.disabled,
        autoAllow: draft.autoAllow,
        idleTimeoutMinutes: Number(draft.idleTimeoutMinutes),
        promotedTools: server.promotedTools,
      })
      const field = nextTransport === 'stdio' ? 'env' : 'headers'
      secretRowOps(
        name,
        field,
        rows,
        secretKeysFromView(snapshot.settingsDocument.view, name, field),
      )
    } catch (nextError) {
      setFormError(nextError instanceof Error ? nextError.message : String(nextError))
      return
    }
    if (await controller.saveServer(name, draft, rows)) {
      setRowSets((current) => ({
        ...current,
        [activeSecretField]: rows.map((row) => ({
          originalKey: row.key.trim(),
          key: row.key.trim(),
          value: '',
        })),
      }))
      setDirty(false)
    }
  }
  const remove = async () => {
    if (await controller.deleteServer(name)) setConfirmDelete(false)
  }

  return (
    <div className="mcp-card">
      <div className="mcp-card-head">
        <div>
          <div className="mcp-row">
            <span className={`mcp-status-dot ${statusClass(status.state)}`} />
            <h2 className="mcp-card-title">{name}</h2>
            <span className={`mcp-badge ${statusClass(status.state)}`}>{status.state}</span>
            {workspaceSourced && (
              <span className="mcp-badge mcp-badge-workspace">workspace</span>
            )}
          </div>
          <p className="mcp-muted">
            {status.toolCount} {status.toolCount === 1 ? 'tool' : 'tools'} cached
            {status.transport === undefined ? '' : ` · ${status.transport}`}
          </p>
        </div>
        <div className="mcp-actions">
          <button
            type="button"
            className="mcp-button"
            disabled={snapshot.busy || draft.disabled}
            onClick={() => void controller.reconnect(name)}
          >
            Reconnect
          </button>
          <button
            type="button"
            className="mcp-button mcp-button-danger"
            disabled={snapshot.busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        </div>
      </div>

      {workspaceSourced && (
        <div className="mcp-layer-notice" role="note">
          This Server is defined or overridden by the workspace .dsh/mcp.json.
          Edits here write the global layer, which the workspace file overrides.
        </div>
      )}
      {status.message !== undefined && status.state === 'error' && (
        <div className="mcp-error" role="alert">{status.message}</div>
      )}
      {confirmDelete && (
        <div className="mcp-confirm">
          <strong>Delete {name}?</strong>
          <span className="mcp-muted">This removes its Config and disconnects the Server.</span>
          <div className="mcp-actions">
            <button
              type="button"
              className="mcp-button mcp-button-danger"
              disabled={snapshot.busy}
              onClick={() => void remove()}
            >
              Confirm delete
            </button>
            <button type="button" className="mcp-button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <form className="mcp-form" onSubmit={save}>
        {formError !== undefined && <div className="mcp-error" role="alert">{formError}</div>}
        <div className="mcp-field-row">
          <label className="mcp-field">
            <span className="mcp-label">Name</span>
            <input className="mcp-input" value={name} readOnly />
          </label>
          <label className="mcp-field">
            <span className="mcp-label">Transport</span>
            <select
              className="mcp-select"
              value={draft.transport}
              disabled={snapshot.busy}
              onChange={(event) => changeDraft({ transport: event.target.value })}
            >
              <option value="stdio">stdio</option>
              <option value="http">Streamable HTTP</option>
            </select>
          </label>
        </div>

        {draft.transport === 'stdio' ? (
          <>
            <label className="mcp-field">
              <span className="mcp-label">Command</span>
              <input
                className="mcp-input"
                value={draft.command}
                disabled={snapshot.busy}
                onChange={(event) => changeDraft({ command: event.target.value })}
              />
            </label>
            <label className="mcp-field">
              <span className="mcp-label">Args as a JSON array</span>
              <textarea
                className="mcp-textarea"
                value={draft.argsText}
                disabled={snapshot.busy}
                spellCheck={false}
                onChange={(event) => changeDraft({ argsText: event.target.value })}
              />
            </label>
            <SecretEditor field="env" rows={rows} onChange={changeRows} disabled={snapshot.busy} />
          </>
        ) : (
          <>
            <label className="mcp-field">
              <span className="mcp-label">URL</span>
              <input
                className="mcp-input"
                value={draft.url}
                disabled={snapshot.busy}
                onChange={(event) => changeDraft({ url: event.target.value })}
              />
            </label>
            <div className="mcp-field-row">
              <label className="mcp-field">
                <span className="mcp-label">HTTP authentication</span>
                <select
                  className="mcp-select"
                  value={draft.auth ?? 'headers'}
                  disabled={snapshot.busy}
                  title="Static headers send fixed values on every request. OAuth 2.0 with PKCE signs in through the provider in your browser."
                  onChange={(event) => changeDraft({ auth: event.target.value })}
                >
                  <option value="headers">Static headers</option>
                  <option value="oauth">OAuth 2.0 with PKCE</option>
                </select>
              </label>
              {draft.auth === 'oauth' && (
                <label className="mcp-field">
                  <span className="mcp-label">OAuth scopes (optional, comma-separated)</span>
                  <input
                    className="mcp-input"
                    value={draft.scopesText}
                    disabled={snapshot.busy}
                    placeholder="read write"
                    title="Optional. Leave empty when the provider defines no scopes — for example Context7. Request only scopes the provider grants."
                    onChange={(event) => changeDraft({ scopesText: event.target.value })}
                  />
                  <span className="mcp-muted">Leave empty unless the provider requires scopes.</span>
                </label>
              )}
            </div>
            {draft.auth === 'oauth' && (
              <p className="mcp-muted">
                OAuth signs in through your browser. The Sign in button appears
                after you save this Server.
              </p>
            )}
            <SecretEditor field="headers" rows={rows} onChange={changeRows} disabled={snapshot.busy} />
          </>
        )}

        <div className="mcp-field-row">
          <label className="mcp-field">
            <span className="mcp-label">Idle timeout in minutes</span>
            <input
              className="mcp-input"
              type="number"
              min="0.1"
              step="0.1"
              value={draft.idleTimeoutMinutes}
              disabled={snapshot.busy}
              onChange={(event) => changeDraft({ idleTimeoutMinutes: event.target.value })}
            />
          </label>
          <div className="mcp-field">
            <span className="mcp-label">Call policy</span>
            <label className="mcp-checkbox">
              <input
                type="checkbox"
                checked={draft.autoAllow}
                disabled={snapshot.busy}
                onChange={(event) => changeDraft({ autoAllow: event.target.checked })}
              />
              Auto-allow calls from this Server
            </label>
          </div>
        </div>
        <label className="mcp-checkbox">
          <input
            type="checkbox"
            checked={draft.disabled}
            disabled={snapshot.busy}
            onChange={(event) => changeDraft({ disabled: event.target.checked })}
          />
          Disable this Server
        </label>
        <div className="mcp-actions">
          <button
            type="submit"
            className="mcp-button mcp-button-primary"
            disabled={workspaceSourced || snapshot.busy || !dirty}
          >
            {snapshot.busy ? 'Saving…' : 'Save Server'}
          </button>
          {dirty && !workspaceSourced && <span className="mcp-muted">Unsaved changes</span>}
          {workspaceSourced && <span className="mcp-muted">Read-only: defined by the workspace</span>}
        </div>
      </form>

      {typeof server.url === 'string' && server.auth === 'oauth' && (
        <OAuthSection controller={controller} snapshot={snapshot} name={name} />
      )}

      <div className="mcp-section">
        <div>
          <h3 className="mcp-section-title">Promotions</h3>
          <p className="mcp-muted">
            Promote selected MCP tools as native tools named {name}__tool.
          </p>
        </div>
        {tools.length === 0 ? (
          <div className="mcp-warning">
            No cached tools are available. Reconnect to discover this Server.
          </div>
        ) : (
          <div className="mcp-promotion-list">
            {tools.map((tool) => {
              const checked = (server.promotedTools ?? []).includes(tool.name)
              return (
                <label className="mcp-promotion" key={tool.name}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={snapshot.busy}
                    onChange={() => void controller.togglePromotion(name, tool.name)}
                  />
                  <span>
                    <span className="mcp-promotion-name">{tool.name}</span>
                    {tool.description !== undefined && (
                      <span className="mcp-promotion-description">{tool.description}</span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function McpSettingsPage({ controller }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [selected, setSelected] = useState()
  const [dialog, setDialog] = useState()
  const settings = snapshot.settings
  const servers = settings.value?.mcpServers ?? {}
  // Workspace-only Servers (absent from the global namespace) still surface:
  // the sidebar unions both sources and the detail renders read-only.
  const workspaceServers = snapshot.layers?.servers ?? {}
  const names = useMemo(
    () => [...new Set([...Object.keys(servers), ...Object.keys(workspaceServers)])].sort(),
    [servers, workspaceServers],
  )

  useEffect(() => controller.mount(), [controller])
  useEffect(() => {
    if (
      selected === undefined ||
      (!Object.hasOwn(servers, selected) && !Object.hasOwn(workspaceServers, selected))
    ) {
      setSelected(names[0])
    }
  }, [names, selected, servers, workspaceServers])

  if (settings.status === 'loading') {
    return <section className="mcp-settings"><p className="mcp-muted">Loading MCP Settings…</p></section>
  }
  if (settings.status !== 'ready') {
    return (
      <section className="mcp-settings">
        <h1 className="mcp-title">MCP</h1>
        <div className="mcp-error" role="alert">
          {settings.error?.message ?? 'MCP Settings are unavailable.'}
        </div>
      </section>
    )
  }

  return (
    <section className="mcp-settings">
      <div className="mcp-toolbar">
        <div>
          <h1 className="mcp-title">MCP</h1>
          <p className="mcp-intro">Connect MCP Servers and choose how their tools reach the Agent.</p>
        </div>
        <div className="mcp-actions">
          <button
            type="button"
            className="mcp-button mcp-button-primary"
            disabled={snapshot.busy || !settings.writable}
            onClick={() => setDialog('add')}
          >
            Add Server
          </button>
        </div>
      </div>

      {!settings.writable && (
        <div className="mcp-warning">The active Settings Provider is read-only.</div>
      )}
      {snapshot.error !== undefined && (
        <div className="mcp-error" role="alert">{snapshot.error}</div>
      )}

      {names.length === 0 ? (
        <div className="mcp-empty">
          <h2 className="mcp-card-title">No MCP Servers</h2>
          <p className="mcp-muted">
            Add a Server through its input fields, or paste an existing mcpServers JSON.
          </p>
          <div className="mcp-actions">
            <button
              type="button"
              className="mcp-button mcp-button-primary"
              disabled={snapshot.busy || !settings.writable}
              onClick={() => setDialog('add')}
            >
              Add Server
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-layout">
          <nav className="mcp-sidebar" aria-label="MCP Servers">
            {names.map((name) => {
              const status = statusFor(snapshot.overview, name)
              const workspaceSourced = serverSource(snapshot.layers, name) === 'workspace'
              return (
                <button
                  type="button"
                  className="mcp-server-button"
                  aria-current={name === selected}
                  key={name}
                  onClick={() => setSelected(name)}
                >
                  <span className={`mcp-status-dot ${statusClass(status.state)}`} />
                  <span className="mcp-server-name">{name}</span>
                  {workspaceSourced && (
                    <span className="mcp-badge mcp-badge-workspace">workspace</span>
                  )}
                  <span className="mcp-server-count">{status.toolCount}</span>
                </button>
              )
            })}
          </nav>
          {selected !== undefined && servers[selected] !== undefined && (
            <ServerDetail
              key={selected}
              controller={controller}
              snapshot={snapshot}
              name={selected}
              server={servers[selected]}
            />
          )}
          {selected !== undefined && servers[selected] === undefined && workspaceServers[selected] !== undefined && (
            <WorkspaceServerDetail
              key={selected}
              controller={controller}
              snapshot={snapshot}
              name={selected}
              server={workspaceServers[selected]}
            />
          )}
        </div>
      )}

      {dialog === 'add' && (
        <AddServerDialog controller={controller} busy={snapshot.busy} onClose={() => setDialog()} />
      )}
    </section>
  )
}
