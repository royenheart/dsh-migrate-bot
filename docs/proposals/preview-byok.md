# Proposal: Bring-your-own-key access for live previews

Status: parked

Resume when: a deployment needs per-viewer billing or the service owner wants to stop paying for shared preview conversations.

## Problem

The first live-preview model path uses a service-owned provider key held by the deploy service. A later deployment may need each viewer to pay for their own model use, or to keep the service owner's key away from a shared preview. BYOK supplies a viewer's own key while preserving the gateway boundary: the preview receives a scoped grant, and the gateway exchanges it for the viewer's key.

## Proposal

Add a trusted control page on the deploy-service origin, behind the same identity proxy as the run and preview pages. After a preview exists, an authenticated viewer can attach a model key to that preview, choose a budget and lifetime, replace it, or revoke it. The service stores the key outside the preview, binds it to the viewer and preview, and the model gateway uses it in place of the service-owned key. The preview only ever sees a short-lived grant.

The first implementation keeps one model protocol and one upstream contract. It reuses the gateway, grant, relay, request cap and preview lifecycle from the service-owned-key path; it adds a credential store, a control page, viewer identity, and per-viewer accounting.

## Decisions needed

- **Credential storage:** decide whether keys live in an encrypted service store or in memory only. An encrypted store supports a key surviving a preview restart; memory only shortens the exposure window and forces re-entry. Recommended: encrypted store with a master secret outside the data directory, plus revoke-on-preview-expiry.
- **Viewer identity:** decide whether the control page trusts a verified identity-provider JWT or a service-issued session after an identity-provider login. Recommended: verify the JWT in the service, bind the key to its `sub`, and never trust a forwarded header.
- **Billing boundary:** decide whether the viewer pays the provider directly or the service resells a budget. Recommended: direct provider billing; the service enforces a request cap and displays usage metadata.
- **Origin:** decide whether the control page uses the existing control origin or a separate credential origin. Recommended: keep it on the control origin, separate from `PREVIEW_DOMAIN`, and use host-only secure cookies.
- **Provider scope:** decide whether BYOK covers one OpenAI-compatible upstream or several fixed upstreams. Recommended: one fixed upstream in the first version, with the provider and model choose configured by the operator.

## Acceptance criteria

- A viewer authenticates, attaches a key to a preview, and completes a streamed model response without local checkout.
- The preview process, its plugin, its environment, its home and the browser storage never contain the provider key.
- A preview can use only its own grant; a grant is revoked by stop, destroy, expiry, or a key rotation.
- The request cap, model allowlist and upstream allowlist apply to service-owned and viewer-owned keys alike.
- An unreachable or rejected key fails closed with a stable response; the service never falls back to another user's or the service owner's key.
- The control page and preview run on distinct origins, and the preview cannot read the control page's credentials with the viewer's browser session.

## Risks

- A stored viewer key becomes a high-value secret; the service needs a rotation and deletion path.
- A compromised preview can consume the viewer's capped budget; the cap must be small and visible.
- A viewer can attach a key with broader permissions than the model call needs; the control page should state the required scope and prefer a dedicated key.
- The gateway or control page becomes a credential-collection surface; access policy, CSRF protection and origin separation are part of the feature, not follow-up work.
