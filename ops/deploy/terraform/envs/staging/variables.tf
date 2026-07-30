variable "aws_region" { type = string }
variable "availability_zones" { type = list(string) }
variable "vpc_cidr" { type = string }
variable "public_subnet_cidrs" { type = list(string) }
variable "private_subnet_cidrs" { type = list(string) }
variable "ami_id" { type = string }
variable "instance_type" { type = string }
variable "state_volume_size_gib" { type = number }
variable "container_image" { type = string }
variable "dns_name" { type = string }
variable "game_acm_certificate_arn" {
  type    = string
  default = ""
}
variable "manage_route53_dns" {
  type    = bool
  default = true
}
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "budget_limit_usd" { type = number }
variable "budget_alert_emails" {
  type    = list(string)
  default = []
}
variable "rpo_minutes" { type = number }
variable "rto_minutes" { type = number }
variable "tags" {
  type    = map(string)
  default = {}
}
variable "alarm_email" {
  type    = string
  default = ""
}
variable "initialize_empty_volume" {
  type    = bool
  default = false
}
variable "backup_interval_minutes" {
  type    = number
  default = 60
}
variable "backup_bucket_name" { type = string }
variable "asset_bucket_name" { type = string }
variable "client_store_origin" { type = string }
variable "runtime_secret_parameter_name" {
  type    = string
  default = "/successor/staging/runtime-secret"
}
variable "runtime_bearer_parameter_name" {
  type    = string
  default = "/successor/staging/runtime-bearer"
}
variable "control_secret_parameter_name" {
  type    = string
  default = "/successor/staging/alpha-control-secret"
}
variable "site_url" {
  type    = string
  default = "https://www.successorgame.com"
}
variable "site_bucket_name" { type = string }
variable "site_aliases" {
  type    = list(string)
  default = []
}
variable "site_acm_certificate_domain_name" {
  type    = string
  default = ""
}
variable "site_acm_certificate_arn" {
  type    = string
  default = ""
}
variable "game_websocket_path_pattern" {
  type    = string
  default = "/open-desert/*"
}
variable "staging_readiness_path" {
  type    = string
  default = "/readyz"
}
variable "staging_readiness_cidr_blocks" {
  type    = list(string)
  default = []
}
