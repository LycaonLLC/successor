output "instance_id" { value = module.shard.instance_id }
output "state_volume_id" { value = module.shard.state_volume_id }
output "ecr_repository_url" { value = module.shard.ecr_repository_url }
output "wss_url" { value = module.shard.wss_url }
output "alb_dns_name" { value = module.shard.alb_dns_name }
output "game_dns_target" { value = module.shard.game_dns_target }
output "game_dns_record" { value = module.shard.game_dns_record }
output "asset_distribution_domain_name" { value = module.shard.asset_distribution_domain_name }
output "backup_bucket" { value = module.shard.backup_bucket }
output "asset_cdn_origin" { value = module.shard.asset_cdn_origin }
output "asset_manifest_url" { value = module.shard.asset_manifest_url }
output "site_distribution_domain_name" { value = module.shard.site_distribution_domain_name }
output "site_bucket" { value = module.shard.site_bucket }
output "site_acm_dns_validation_records" { value = module.shard.site_acm_dns_validation_records }
output "site_cutover_dns_record" {
  value = {
    name   = "www.successorgame.com"
    type   = "CNAME"
    value  = module.shard.site_distribution_domain_name
    action = "operator-managed Cloudflare cutover; do not apply in Terraform"
  }
}
