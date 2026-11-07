---
kind: operations
description: Running the reference deploy service on any host with Docker, by hand or with a coding agent, or on Hetzner Cloud with the Terraform module; wiring a consumer repository to it, and verifying it with the conformance suite.
---

# Running the deploy service

The reference deploy service lives in `deploy-service/`. [The deploy service design](../design/deploy-service.md) explains what it serves and the contract it keeps; this page is how to run it, point a repository at it, and check that it works.

## The images

There are two images, both built from this repository.

| Image | Build | Contents |
|---|---|---|
| The service | `docker build -f deploy-service/Dockerfile -t dsh-migrate-deploy-service .` from the repository root | The service, git, and the Docker CLI |
| The preview image | `docker build --build-arg DSH_VERSION=0.2.0-rc.2 -t dsh-migrate-preview:0.2.0-rc.2 deploy-service/preview-image` | One pinned `@deepseek-ai/dsh` and the launcher every preview runs |

The preview image's tag names its dsh version, and Compose derives `DSH_IMAGE` from `DSH_VERSION`, so every preview of a deployment runs the same dsh. To move previews to another release, build the image with another `DSH_VERSION`; one value changes both the build tag and the service's image. A custom image needs a Compose override. After changing `DSH_VERSION` on an existing deployment, rebuild the preview image and recreate the service so it picks up the derived image tag.

## Configuration

The service is configured only by its environment. It validates every variable at start and exits with the list of problems instead of listening. With `deploy-service/compose.yaml`, every variable comes from `deploy-service/.env`, except where the table says compose fixes it.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_TOKEN` | yes | The bearer token the Action sends; at least 16 characters. The consumer stores the same value as `DSH_MIGRATE_DEPLOY_TOKEN` |
| `GITHUB_WEBHOOK_SECRET` | yes | The secret of the repository webhook; at least 16 characters |
| `DATA_DIR` | yes | Absolute path of the data directory, at most 62 bytes because preview sockets live under it. With the `docker` provider it must be the same path on the host and in the service's container |
| `PUBLIC_URL` | yes | The service's public base URL; run pages and preview links are built from it |
| `PROVIDER` | yes | `docker`, or `process` for CI and tests. Compose fixes it to `docker` |
| `DSH_IMAGE` | with `docker` | The preview image. Compose derives it as `dsh-migrate-preview:<DSH_VERSION>`; only a direct service run or a Compose override sets it explicitly |
| `DSH_VERSION` | with `process`, unless `DSH_BIN` is set | The dsh version previews run. Compose uses it as the preview image's build tag and derives `DSH_IMAGE` from it; it must be Docker-tag-safe, so a semver build metadata suffix is not supported |
| `DSH_BIN` | no | An installed `dsh` the `process` provider uses instead. Compose does not pass it |
| `IDLE_MINUTES` | no, 120 | Minutes without a request through the preview proxy before an instance stops |
| `TTL_DAYS` | no, 7 | Days from creation to a preview's first expiry. `extend` moves it out, never past the consumer's `deploy.preview.ttlDays` (14 by default) after creation, so keep it below that |
| `RETENTION_DAYS` | no, 90 | Days a run record, its log and its evidence are kept; the periodic sweep deletes older records |
| `PUBLIC_VIEWS` | no, `false` | `true` serves `/view/…`, `/p/…` and, when `PREVIEW_DOMAIN` is set, `p-<id>.<PREVIEW_DOMAIN>` without the token; only behind an identity-aware proxy. With `PUBLIC_VIEWS=false`, those paths require the deploy bearer, so a browser preview needs an identity proxy and `PUBLIC_VIEWS=true` |
| `EVIDENCE_URL` | no | Dedicated base URL of the benchmark site; when set, a run page's evidence link opens the integrated Run evidence page instead of the raw JSON. Its origin receives credentialed CORS, so it must not share an origin with unrelated pages. If the site cannot authenticate, its Run evidence page offers a link to the run page for the identity-provider login |
| `PREVIEW_DOMAIN` | no | Optional DNS suffix for preview origins. When set, a preview answers on `p-<id>.<PREVIEW_DOMAIN>` and the old `/p/<id>/` path redirects there. The preview and the control/run pages then have different origins |
| `MODEL_API_KEY` | no | Service-owned provider key for live preview conversations. Empty keeps previews keyless. Supply it through the deployment environment (for example Compose `.env` or an operator-provided secret environment), never Git; the gateway is the only process that reads it |
| `MODEL_UPSTREAM` | no, `https://api.deepseek.com/anthropic` | Fixed DeepSeek Messages-compatible upstream base for the model gateway; it carries a path and no trailing `/v1`, uses HTTPS (loopback may use HTTP), and the gateway forwards only `/v1/messages` and `/v1/models` |
| `MODEL_MODELS` | no | Comma-separated model ids the gateway admits; empty admits every id |
| `MODEL_MAX_REQUESTS` | no, 200 | Model requests one preview grant may make |
| `MODEL_MAX_BODY_BYTES` | no, 20971520 | Largest Messages request body the gateway buffers, in bytes |
| `MODEL_MAX_CONCURRENCY` | no, 2 | Concurrent model requests one preview grant may keep in flight |
| `MODEL_GLOBAL_CONCURRENCY` | no, 20 | Concurrent model requests the gateway serves across all previews |
| `MODEL_TIMEOUT_MS` | no, 600000 | Upstream request deadline, in milliseconds |
| `PORT`, `HOST` | no, 8080 and `0.0.0.0` | Where the service listens. Compose fixes them to the defaults, because Caddy and `cloudflared` reach the service at `service:8080` |
| `INSTANCE_PREFIX` | no, `dsh-preview-` | Prefix of every container the `docker` provider creates; it touches no other container. Two services on one Docker daemon need different prefixes |

`--conformance` is the only flag; it is for a deployment the conformance suite checks, never for one a repository uses. Run the suite against the service directly, or from inside the identity proxy: it carries the deploy bearer, not an interactive Access login, so an outward IAP redirect is outside the suite's view-policy check.

## Model access in a preview

The preview can use a model while the real provider key stays in the deploy service. Set `MODEL_API_KEY` in the service's secret environment; the service starts a model gateway, each preview start receives an instance-lifetime grant, and the preview's dsh server sends requests through a loopback relay to that gateway. The gateway replaces the grant with the provider key and forwards one fixed DeepSeek Messages-compatible path. The preview process and its plugin receive the grant, which is scoped to that preview, its request cap and its concurrency; the provider key never reaches the preview or the browser.

The gateway defaults to `https://api.deepseek.com/anthropic`; `MODEL_UPSTREAM` selects another fixed origin. `MODEL_MODELS` limits the model ids, `MODEL_MAX_REQUESTS` caps one grant; `MODEL_MAX_BODY_BYTES`, `MODEL_MAX_CONCURRENCY`, `MODEL_GLOBAL_CONCURRENCY` and `MODEL_TIMEOUT_MS` bound the request path. A grant lives with its preview deployment and is revoked when that instance stops, is destroyed, expires or is rebuilt; after the request cap, redeploy or restart the preview to issue a new grant. Rebuild the preview image as well as the service image when updating the launcher: the preview image carries the forwarder relay and its tag changes only with `DSH_VERSION`. The gateway listens on a Unix socket inside `DATA_DIR/model/` for the Docker provider and a loopback TCP port for the process provider; the preview container keeps `--network none`, and only its forwarder mounts the gateway socket. When `MODEL_API_KEY` is empty, previews remain keyless and no gateway starts. A viewer who saves a model key in the preview's Settings → Models page shadows the grant because dsh reads its local credential store before the inherited environment; clear that saved key or reset the preview home to recover. The process provider runs preview code as the service user and is intended for CI or local checks; use the Docker provider when the provider-key boundary must hold.

Set `PREVIEW_DOMAIN` when previews should have their own origins. The service then builds preview URLs as `<scheme>://p-<id>.<PREVIEW_DOMAIN>/` and redirects the old `/p/<id>/` path there; use the Cloudflare Tunnel profile with a wildcard public hostname for `*.PREVIEW_DOMAIN` and separate Access applications for the plugin and safe entries; the reference Caddy `public` profile serves only `PUBLIC_HOSTNAME`, so use the Tunnel profile for preview origins or add a wildcard Caddy site explicitly. A wildcard certificate alone does not add that site. The control page and run pages stay on `PUBLIC_URL`.

## On any host with Docker

The service runs on any Linux host that meets these requirements, from any cloud or VPS provider or on a machine of your own:

| Requirement | Why |
|---|---|
| Docker Engine with the Compose plugin | The stack is `deploy-service/compose.yaml`, and the `docker` provider starts each preview as a container |
| Inbound 80 and 443 with a DNS name for the host, or a Cloudflare Tunnel | Caddy obtains a certificate for `PUBLIC_HOSTNAME`; a tunnel needs no inbound port, for a host behind NAT |
| Outbound access to GitHub and the npm registry | The service clones the previewed repository, and a preview installs its dependencies |
| A data directory whose absolute path is at most 62 bytes, on storage that survives a re-created host | `DATA_DIR` holds every record and working copy |
| Node.js 22.19 or later with npm, where the conformance suite runs | `npm ci && npm run build` builds the suite ([Verifying a deployment](#verifying-a-deployment)); the service itself runs in its image |
| On a cloud host whose metadata endpoint serves secrets, containers cut off from it | A preview's dependency install has a network: add `iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP` and keep it across restarts, as the Terraform module's `deploy-service/terraform/cloud-init.yaml.tftpl` does. The whole link-local range, because providers serve metadata at different addresses in it (Tencent Cloud at `169.254.0.23`) |

`deploy-service/compose.yaml` runs the service, builds the preview image, and fronts the service with Caddy, which obtains a certificate for `PUBLIC_HOSTNAME`, or with `cloudflared`, which connects a Cloudflare Tunnel so the machine needs no inbound port.

1. Copy `deploy-service/.env.example` to `deploy-service/.env` and fill it in. Generate the token with `openssl rand -hex 32`, and use hex for the webhook secret too: `.env` is not a shell file, and quoting differs between readers.
2. Create `DATA_DIR`. It holds the run records, the working copies, the frozen revisions and Caddy's certificates; it is the one directory to back up.
3. Set `EVIDENCE_URL` to the benchmark site when its Run evidence page should open a run directly; leave it empty to link the JSON bundle. Build the preview image: `docker compose --profile build-only build preview-image`. A build step resolves names with the resolvers in the host's `/etc/resolv.conf`; when that is a resolver only the host reaches, such as Tailscale's MagicDNS at `100.100.100.100`, `apt-get` and `npm` in the build fail to resolve. Then build on the host network: a `compose.override.yaml` beside `compose.yaml` that sets `build.network: host` for `service` and `preview-image`.
4. Start the stack with `COMPOSE_PROFILES=public` (Caddy) or `COMPOSE_PROFILES=tunnel` (Cloudflare Tunnel) in `.env`: `docker compose up -d --build`.

The Docker socket is mounted into the service container only, so the service can start preview containers; a preview container never sees it. A serving preview has no network; the dependency install runs on Docker's default bridge, so block the cloud metadata endpoint for containers on a machine whose metadata holds secrets, as the Terraform module does. With a tunnel, create the tunnel in Cloudflare Zero Trust with a public hostname that routes to `http://service:8080`, and put a separate Access application with your policy on `/view/*` and on `/p/*`; when `PREVIEW_DOMAIN` is enabled, put the plugin and safe applications on the corresponding `p-<id>.<PREVIEW_DOMAIN>` hosts as well; the run page carries source and trace, so its policy should be the narrower one. Set `PUBLIC_VIEWS=true` only once those policies are in place. The API paths (`/runs`, `/previews`, `/github/webhook`) must stay reachable without Access, because GitHub and the runner cannot log in: the token and the webhook signature protect them. Without an identity-aware proxy, keep `PUBLIC_VIEWS=false`; the pages then answer only requests that carry the token, which a browser does not send. The Action's `deploy.trace` defaults to `summary`; use `full` only when the `/view/*` policy is restricted to the people who may read the source. Run records are kept under `DATA_DIR/runs` for `RETENTION_DAYS`; evidence bundles are stored per run with a migration history index, so the trace and prompts are data at rest as well as a page.

## On Hetzner Cloud with the Terraform module

The Terraform module is one way to get such a host, on Hetzner Cloud; on another provider, create the host by its own means and follow the section above, whose steps `deploy-service/terraform/cloud-init.yaml.tftpl` also performs. `deploy-service/terraform/` creates one server, a separate volume for `DATA_DIR` that a re-created server keeps, and a firewall that opens 80 and 443, or nothing inbound when a tunnel token is given. Cloud-init installs Docker, drops container traffic to the link-local range (`169.254.0.0/16`; Hetzner's metadata endpoint at `169.254.169.254` serves the user data and its secrets), mounts the volume, clones this repository at `source_ref`, writes `.env` with a generated `DEPLOY_TOKEN`, builds both images, and starts the stack. The cost is that of one small server and one volume while they exist.

```sh
cd deploy-service/terraform
export HCLOUD_TOKEN=…                      # a Hetzner Cloud project API token
terraform init
terraform apply -var github_webhook_secret="$(openssl rand -hex 32)"
terraform output -raw deploy_token
```

| Input | Default | Meaning |
|---|---|---|
| `github_webhook_secret` | required, sensitive | The repository webhook's secret |
| `server_type` | `cpx21` | Hetzner server type |
| `location` | `fsn1` | Hetzner location of the server and the volume |
| `image` | `ubuntu-24.04` | Operating system image of the server; cloud-init expects Ubuntu |
| `public_hostname` | `<server IPv4>.sslip.io` | Hostname the service answers on; point a DNS record at `server_ipv4` when you set your own. Required with a tunnel |
| `cloudflare_tunnel_token` | empty, sensitive | Run behind a Cloudflare Tunnel with no inbound port |
| `ssh_key_ids` | none | Hetzner SSH key ids for root; the firewall opens no SSH port |
| `volume_size` | 20 | Size of the data volume in GB |
| `public_views` | `false` | `PUBLIC_VIEWS`; the reference module requires a Tunnel token for an identity-aware proxy, while a manual Compose deployment can supply one |
| `evidence_url` | empty | `EVIDENCE_URL` |
| `retention_days` | 90 | `RETENTION_DAYS` |
| `preview_domain` | empty | `PREVIEW_DOMAIN`; the reference module requires a Tunnel token, then route `*.preview_domain` to the service and put the Access applications on the plugin and safe entries. A manual Compose deployment must add a wildcard Caddy site explicitly |
| `model_api_key` | empty, sensitive | `MODEL_API_KEY`; it is written into the server user data, so it is also in Terraform state. Keep the state operator-readable, or inject the value out of band |
| `model_upstream` | `https://api.deepseek.com/anthropic` | Fixed DeepSeek Messages-compatible upstream |
| `model_models` | empty | Comma-separated allowed model ids |
| `model_max_requests` | 200 | Requests one preview grant may make |
| `model_max_body_bytes` | 20971520 | Largest buffered request body |
| `model_max_concurrency` | 2 | Concurrent model requests per preview |
| `model_global_concurrency` | 20 | Concurrent model requests across previews |
| `model_timeout_ms` | 600000 | Upstream request deadline |
| `dsh_version` | `0.2.0-rc.2` | The dsh version of the preview image |
| `source_repository`, `source_ref` | this repository, `main` | What the server builds; it must be readable without credentials |
| `conformance_mode` | `false` | Start the service with `--conformance`; for a throwaway check only |
| `name` | `dsh-deploy` | Prefix of every resource |

| Output | Meaning |
|---|---|
| `endpoint` | `deploy.endpoint` for the consumer |
| `webhook_url` | The payload URL of the repository webhook |
| `deploy_token` | The consumer's `DSH_MIGRATE_DEPLOY_TOKEN`; sensitive |
| `server_ipv4` | The server's address |

The webhook secret and the generated token are in the Terraform state and in the server's user data, so keep the state where only the operator can read it. The first boot takes several minutes, most of it building the two images; `curl "$(terraform output -raw endpoint)/healthz"` answers once the service listens.

## Setting it up with an agent

A coding agent can run the service for a maintainer by following this page; it asks, then applies the sections above. It reads the page of the release the consumer pins, as [installing the Action with an agent](install.md#setting-it-up-with-an-agent) does.

| Question | Default | Becomes |
|---|---|---|
| Which host runs the service: a host the maintainer already has, a new one at a provider of their choice, or Hetzner Cloud with the Terraform module | None; the agent does not choose a provider or create billable resources unasked | The section it follows |
| How the service is reached: a DNS name pointing at the host, or a Cloudflare Tunnel | A DNS name | `PUBLIC_HOSTNAME` and `COMPOSE_PROFILES=public`, or the tunnel token and `COMPOSE_PROFILES=tunnel` |
| Who may open run pages and previews | Only requests that carry the token | `PUBLIC_VIEWS=true` only behind an identity-aware proxy the maintainer has set up |
| Where the data lives | `/srv/dsh-deploy` | `DATA_DIR` |
| Which dsh release previews run | The one in `deploy-service/.env.example` | `DSH_VERSION` |
| Which repositories use it | The one being set up | A webhook in each; the service previews public repositories only |

On the host, the agent checks the requirements of [On any host with Docker](#on-any-host-with-docker) before writing anything, generates `DEPLOY_TOKEN` and `GITHUB_WEBHOOK_SECRET` there with `openssl rand -hex 32` into `deploy-service/.env`, readable only by its owner, and never prints them. It starts the stack, waits for `/healthz`, and runs the conformance suite ([Verifying a deployment](#verifying-a-deployment)). The maintainer then copies `DEPLOY_TOKEN` into the consumer's secret `DSH_MIGRATE_DEPLOY_TOKEN` and the webhook secret into the webhook, or lets the agent pipe each from `.env` into `gh secret set` and into `gh api --input`, so that no value appears in the conversation or on a command line. The consumer side is [Wiring a consumer repository](#wiring-a-consumer-repository).

## Wiring a consumer repository

1. In the consumer's `.github/dsh-migrate.yml`:

   ```yaml
   deploy:
     enabled: true
     endpoint: https://deploy.example.com
   ```

2. Add the repository secret `DSH_MIGRATE_DEPLOY_TOKEN` with the service's `DEPLOY_TOKEN`.
3. Add a repository webhook (Settings → Webhooks): payload URL `https://deploy.example.com/github/webhook`, content type `application/json`, the secret `GITHUB_WEBHOOK_SECRET`, and only the **Pull requests** event. The service builds a preview when a pull request whose branch is in the repository itself is opened, reopened or pushed to, and destroys it when the pull request closes. A pull request from a fork gets no preview.

The reference service clones the repository over the `https:` clone URL in the event without credentials, so it previews public repositories. The [configuration reference](../reference/configuration.md) lists the `deploy.*` keys, among them `deploy.preview.ttlDays` and `deploy.preview.extendDays`, which bound what `extend` asks for.

## Verifying a deployment

The conformance suite checks a deployment from the Action's side ([what it checks](../design/deploy-service.md#10-the-conformance-suite)):

```sh
cd deploy-service && npm ci && npm run build
DEPLOY_TOKEN=… node dist/conformance/run.js --url https://deploy.example.com
```

Against a production deployment, the preview checks need `--preview owner/name#N` naming a preview with an unpublished change in its working copy; without one they are skipped. The suite changes that preview: it extends it by a day with a ceiling of 365 days, which can move its expiry past the consumer's `deploy.preview.ttlDays`; it freezes a revision and reports a refusal for it; and it `redeploy`s it, which stops the instance and rebuilds it from the pull request's head. It never pushes anything. A throwaway deployment started with `--conformance` (the Terraform input `conformance_mode`) runs every check with `--conformance`, including the refusals of a slow answer, an oversize answer and a redirect. The manual workflow `deploy-service-cloud-check` does exactly that on a Hetzner Cloud server it creates and destroys; it needs the repository secrets `HCLOUD_TOKEN` and `DSH_DEPLOY_CHECK_WEBHOOK_SECRET`.
