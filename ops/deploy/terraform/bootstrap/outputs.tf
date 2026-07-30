output "state_bucket_name" { value = aws_s3_bucket.state.bucket }
output "backend_config" {
  value = {
    bucket       = aws_s3_bucket.state.bucket
    key          = "successor/bootstrap/terraform.tfstate"
    region       = var.aws_region
    encrypt      = true
    use_lockfile = true
  }
}
output "hosted_zone_id" {
  value       = aws_route53_zone.successor.zone_id
  description = "Route53 zone id to pass into the staging environment."
}
output "hosted_zone_name" {
  value = aws_route53_zone.successor.name
}
output "name_servers" {
  value       = aws_route53_zone.successor.name_servers
  description = "Delegate all returned name servers at the parent DNS provider."
}
