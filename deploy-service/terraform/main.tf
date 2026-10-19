locals {
  tunnel   = var.cloudflare_tunnel_token != ""
  data_dir = "/srv/dsh-deploy"
  hostname = var.public_hostname != "" ? var.public_hostname : "${hcloud_server.service.ipv4_address}.sslip.io"
}

resource "random_password" "deploy_token" {
  length  = 48
  special = false
}

# DATA_DIR lives on its own volume, so replacing the server keeps the run
# records, the working copies and the frozen revisions.
resource "hcloud_volume" "data" {
  name     = "${var.name}-data"
  size     = var.volume_size
  location = var.location
  format   = "ext4"
}

resource "hcloud_firewall" "service" {
  name = "${var.name}-firewall"

  # With a tunnel the server only connects out; without one, Caddy needs 80
  # for the ACME challenge and the redirect, and 443 for the service.
  dynamic "rule" {
    for_each = local.tunnel ? [] : ["80", "443"]
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = rule.value
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }
}

resource "hcloud_server" "service" {
  name         = var.name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = var.ssh_key_ids
  firewall_ids = [hcloud_firewall.service.id]
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    volume_id             = hcloud_volume.data.id
    data_dir              = local.data_dir
    public_hostname       = var.public_hostname
    deploy_token          = random_password.deploy_token.result
    github_webhook_secret = var.github_webhook_secret
    tunnel_token          = var.cloudflare_tunnel_token
    profile               = local.tunnel ? "tunnel" : "public"
    public_views          = var.public_views ? "true" : "false"
    dsh_version           = var.dsh_version
    source_repository     = var.source_repository
    source_ref            = var.source_ref
    service_flags         = var.conformance_mode ? "--conformance" : ""
  })

  lifecycle {
    precondition {
      condition     = !local.tunnel || var.public_hostname != ""
      error_message = "public_hostname is required with a tunnel: it is the hostname the tunnel routes to the service."
    }
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.service.id
  automount = false
}
