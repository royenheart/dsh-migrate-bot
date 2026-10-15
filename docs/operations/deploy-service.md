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

The preview image's tag names its dsh version, and `DSH_IMAGE` names the tag, so every preview of a deployment runs the same dsh. To move previews to another release, build the image with another `DSH_VERSION` and change `DSH_IMAGE`.

## Configuration

The service is configured only by its environment. It validates every variable at start and exits with the list of problems instead of listening.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_TOKEN` | yes | The bearer token the Action sends; at least 16 characters. The consumer stores the same value as `DSH_MIGRATE_DEPLOY_TOKEN` |
| `GITHUB_WEBHOOK_SECRET` | yes | The secret of the repository webhook; at least 16 characters |
| `DATA_DIR` | yes | Absolute path of the data directory, at most 64 characters because preview sockets live under it. With the `docker` provider it must be the same path on the host and in the service's container |
| `PUBLIC_URL` | yes | The service's public base URL; run pages and preview links are built from it |
| `PROVIDER` | yes | `docker`, or `process` for CI and tests |
| `DSH_IMAGE` | with `docker` | The preview image |
| `DSH_VERSION` | with `process`, unless `DSH_BIN` is set | The dsh version installed into `DATA_DIR/dsh/` |
| `DSH_BIN` | no | An installed `dsh` the `process` provider uses instead |
| `IDLE_MINUTES` | no, 120 | Minutes without a request through the preview proxy before an instance stops |
| `TTL_DAYS` | no, 3 | Days from creation to a preview's first expiry. `extend` moves it out, never past the consumer's `deploy.preview.ttlDays` (7 by default) after creation, so keep it below that |
| `PUBLIC_VIEWS` | no, `false` | `true` serves `/view/…` and `/p/…` without the token; only behind an identity-aware proxy |
| `PORT`, `HOST` | no, 8080 and `0.0.0.0` | Where the service listens |
| `INSTANCE_PREFIX` | no, `dsh-preview-` | Prefix of every container the `docker` provider creates; it touches no other container |

`--conformance` is the only flag; it is for a deployment the conformance suite checks, never for one a repository uses.

## On any host with Docker

The service runs on any Linux host that meets these requirements, from any cloud or VPS provider or on a machine of your own:

| Requirement | Why |
|---|---|
| Docker Engine with the Compose plugin | The stack is `deploy-service/compose.yaml`, and the `docker` provider starts each preview as a container |
| Inbound 80 and 443 with a DNS name for the host, or a Cloudflare Tunnel | Caddy obtains a certificate for `PUBLIC_HOSTNAME`; a tunnel needs no inbound port, for a host behind NAT |
| Outbound access to GitHub and the npm registry | The service clones the previewed repository, and a preview installs its dependencies |
| A data directory whose absolute path is at most 64 characters, on storage that survives a re-created host | `DATA_DIR` holds every record and working copy |
| On a cloud host whose metadata endpoint serves secrets, containers cut off from it | A preview's dependency install has a network: add `iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP` and keep it across restarts, as the Terraform module's `deploy-service/terraform/cloud-init.yaml.tftpl` does |

`deploy-service/compose.yaml` runs the service, builds the preview image, and fronts the service with Caddy, which obtains a certificate for `PUBLIC_HOSTNAME`, or with `cloudflared`, which connects a Cloudflare Tunnel so the machine needs no inbound port.

1. Copy `deploy-service/.env.example` to `deploy-service/.env` and fill it in. Generate the token with `openssl rand -hex 32`, and use hex for the webhook secret too: `.env` is not a shell file, and quoting differs between readers.
2. Create `DATA_DIR`. It holds the run records, the working copies, the frozen revisions and Caddy's certificates; it is the one directory to back up.
3. Build the preview image: `docker compose --profile build-only build preview-image`.
4. Start the stack with `COMPOSE_PROFILES=public` (Caddy) or `COMPOSE_PROFILES=tunnel` (Cloudflare Tunnel) in `.env`: `docker compose up -d --build`.

The Docker socket is mounted into the service container only, so the service can start preview containers; a preview container never sees it. A serving preview has no network; the dependency install runs on Docker's default bridge, so block the cloud metadata endpoint for containers on a machine whose metadata holds secrets, as the Terraform module does. With a tunnel, create the tunnel in Cloudflare Zero Trust with a public hostname that routes to `http://service:8080`, and put an Access application with your policy on the paths `/view/*` and `/p/*`; set `PUBLIC_VIEWS=true` only once that policy is in place. The API paths (`/runs`, `/previews`, `/github/webhook`) must stay reachable without Access, because GitHub and the runner cannot log in: the token and the webhook signature protect them. Without an identity-aware proxy, keep `PUBLIC_VIEWS=false`; the pages then answer only requests that carry the token, which a browser does not send.

## On Hetzner Cloud with the Terraform module

The Terraform module is one way to get such a host, on Hetzner Cloud; on another provider, create the host by its own means and follow the section above, whose steps `deploy-service/terraform/cloud-init.yaml.tftpl` also performs. `deploy-service/terraform/` creates one server, a separate volume for `DATA_DIR` that a re-created server keeps, and a firewall that opens 80 and 443, or nothing inbound when a tunnel token is given. Cloud-init installs Docker, drops container traffic to the metadata endpoint (`169.254.169.254`, which serves the user data and its secrets), mounts the volume, clones this repository at `source_ref`, writes `.env` with a generated `DEPLOY_TOKEN`, builds both images, and starts the stack. The cost is that of one small server and one volume while they exist.

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
| `public_hostname` | `<server IPv4>.sslip.io` | Hostname the service answers on; point a DNS record at `server_ipv4` when you set your own. Required with a tunnel |
| `cloudflare_tunnel_token` | empty, sensitive | Run behind a Cloudflare Tunnel with no inbound port |
| `ssh_key_ids` | none | Hetzner SSH key ids for root; the firewall opens no SSH port |
| `volume_size` | 20 | Size of the data volume in GB |
| `public_views` | `false` | `PUBLIC_VIEWS` |
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
| Which dsh release previews run | The one in `deploy-service/.env.example` | `DSH_VERSION`, `DSH_IMAGE` |
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

Against a production deployment, the preview checks need `--preview owner/name#N` naming a preview with an unpublished change in its working copy; without one they are skipped. A throwaway deployment started with `--conformance` (the Terraform input `conformance_mode`) runs every check with `--conformance`, including the refusals of a slow answer, an oversize answer and a redirect. The manual workflow `deploy-service-cloud-check` does exactly that on a Hetzner Cloud server it creates and destroys; it needs the repository secrets `HCLOUD_TOKEN` and `DSH_DEPLOY_CHECK_WEBHOOK_SECRET`.
