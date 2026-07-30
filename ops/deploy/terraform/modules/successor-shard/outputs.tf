output "vpc_id" { value = aws_vpc.this.id }
output "instance_id" { value = aws_instance.this.id }
output "state_volume_id" { value = aws_ebs_volume.state.id }
output "ecr_repository_url" { value = aws_ecr_repository.server.repository_url }
output "wss_url" { value = "wss://${var.dns_name}" }
output "alb_dns_name" {
  value       = aws_lb.this.dns_name
  description = "Public ALB DNS name; use as the external DNS target when Route 53 management is disabled."
}
output "game_dns_target" {
  value       = aws_lb.this.dns_name
  description = "Operator DNS target for dns_name."
}
output "game_dns_record" {
  value = {
    name   = var.dns_name
    type   = var.manage_route53_dns ? "A" : "CNAME"
    value  = aws_lb.this.dns_name
    action = var.manage_route53_dns ? "Route 53 alias managed by Terraform" : "Create this record at the external DNS provider (for example, Cloudflare); do not apply it in Terraform"
  }
  description = "Operator publication instruction for the game hostname."
}
output "asset_distribution_domain_name" { value = aws_cloudfront_distribution.assets.domain_name }
output "backup_bucket" { value = aws_s3_bucket.backup.bucket }
output "asset_cdn_origin" {
  value       = "https://${aws_cloudfront_distribution.assets.domain_name}"
  description = "CloudFront origin for immutable client assets."
}
output "asset_manifest_url" {
  value       = "https://${aws_cloudfront_distribution.assets.domain_name}/current.json"
  description = "Mutable no-cache client asset pointer URL for the browser client."
}
output "site_distribution_domain_name" {
  value       = aws_cloudfront_distribution.site.domain_name
  description = "Standalone site CloudFront hostname; publish this as the operator cutover target."
}
output "site_bucket" { value = aws_s3_bucket.site.bucket }
