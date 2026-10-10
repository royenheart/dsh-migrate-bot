output "endpoint" {
  description = "deploy.endpoint for the consumer's .github/dsh-migrate.yml."
  value       = "https://${local.hostname}"
}

output "webhook_url" {
  description = "Payload URL of the repository webhook for pull_request events."
  value       = "https://${local.hostname}/github/webhook"
}

output "deploy_token" {
  description = "The value of the consumer's DSH_MIGRATE_DEPLOY_TOKEN secret."
  value       = random_password.deploy_token.result
  sensitive   = true
}

output "server_ipv4" {
  description = "The server's public IPv4 address."
  value       = hcloud_server.service.ipv4_address
}
