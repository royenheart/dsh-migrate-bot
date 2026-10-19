variable "name" {
  description = "Prefix of every resource this module creates."
  type        = string
  default     = "dsh-deploy"
}

variable "server_type" {
  description = "Hetzner server type; one small shared-CPU server runs the service and its previews."
  type        = string
  default     = "cpx21"
}

variable "location" {
  description = "Hetzner location of the server and its volume, such as fsn1, nbg1, hel1 or ash."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "Operating system image; cloud-init expects Ubuntu."
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_key_ids" {
  description = "Hetzner SSH key ids installed for root. The firewall opens no SSH port; open one in the console when you need it."
  type        = list(number)
  default     = []
}

variable "volume_size" {
  description = "Size in GB of the volume that holds DATA_DIR: run records, working copies, revisions and Caddy's certificates."
  type        = number
  default     = 20
}

variable "public_hostname" {
  description = "Hostname the service answers on. Empty: <server IPv4>.sslip.io, with a certificate from Let's Encrypt. Required with a tunnel, where it is the hostname the tunnel routes."
  type        = string
  default     = ""
}

variable "github_webhook_secret" {
  description = "Secret of the repository webhook that sends pull_request events to /github/webhook."
  type        = string
  sensitive   = true
}

variable "cloudflare_tunnel_token" {
  description = "Token of a Cloudflare Tunnel whose public hostname routes to http://service:8080. When set, no inbound port is open."
  type        = string
  sensitive   = true
  default     = ""
}

variable "public_views" {
  description = "Serve /view/ and /p/ without the deploy token: only behind an identity-aware proxy such as Cloudflare Access."
  type        = bool
  default     = false
}

variable "dsh_version" {
  description = "The @deepseek-ai/dsh version the preview image installs."
  type        = string
  default     = "0.2.0-rc.2"
}

variable "source_repository" {
  description = "Git URL of this repository; the server builds the service and preview images from it."
  type        = string
  default     = "https://github.com/royenheart/dsh-migrate-bot.git"
}

variable "source_ref" {
  description = "Branch, tag or commit of source_repository to build."
  type        = string
  default     = "main"
}

variable "conformance_mode" {
  description = "Start the service with --conformance. Only for a throwaway deployment that the conformance suite checks."
  type        = bool
  default     = false
}
