variable "name" {
  type        = string
  description = "Stable shard resource prefix."
}

variable "region" {
  type        = string
  description = "AWS region; choose an x86-capable region deliberately."
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR."
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Exactly two public subnet CIDRs for the ALB."
  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "The synthetic shard requires exactly two public subnets."
  }
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "Exactly two private subnet CIDRs; the instance uses the first."
  validation {
    condition     = length(var.private_subnet_cidrs) == 2
    error_message = "The synthetic shard requires exactly two private subnets."
  }
}

variable "availability_zones" {
  type        = list(string)
  description = "Two explicit AZs in region."
  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Exactly two availability zones are required."
  }
}

variable "ami_id" {
  type        = string
  description = "Pinned Amazon Linux 2023 x86_64 AMI ID."
}

variable "instance_type" {
  type        = string
  description = "Pinned x86 EC2 SKU for the synthetic shard."
  validation {
    condition     = can(regex("^(t3|m5|m6i|c5|c6i|r5|r6i)\\.", var.instance_type))
    error_message = "instance_type must be an approved x86 family, not ARM/Graviton."
  }
}

variable "state_volume_size_gib" {
  type        = number
  description = "Encrypted, single-attach EBS state volume size."
  validation {
    condition     = var.state_volume_size_gib >= 20
    error_message = "State volume must be at least 20 GiB."
  }
}

variable "container_image" {
  type        = string
  description = "Immutable ECR image reference including @sha256 digest."
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "container_image must be pinned to a 64-character sha256 digest."
  }
}

variable "dns_name" {
  type        = string
  description = "WSS hostname for the ALB certificate."
}

variable "game_acm_certificate_arn" {
  type        = string
  description = "Optional externally validated ACM certificate ARN for the game ALB listener; empty requests and validates ACM through Route 53."
  default     = ""
  validation {
    condition     = var.game_acm_certificate_arn == "" || can(regex("^arn:[^:]+:acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-fA-F-]{36}$", var.game_acm_certificate_arn))
    error_message = "game_acm_certificate_arn must be a valid ACM certificate ARN."
  }
}

variable "manage_route53_dns" {
  type        = bool
  description = "Whether Terraform manages the game DNS alias and ACM DNS validation records in Route 53."
  default     = true
}

variable "route53_zone_id" {
  type        = string
  description = "Public Route 53 zone containing dns_name for ACM DNS validation and the optional game alias."
  default     = ""
}

variable "rpo_minutes" {
  type        = number
  description = "Desired recovery point objective, documented and alarmed."
  validation {
    condition     = var.rpo_minutes > 0
    error_message = "rpo_minutes must be positive."
  }
}

variable "rto_minutes" {
  type        = number
  description = "Desired recovery time objective, documented and alarmed."
  validation {
    condition     = var.rto_minutes > 0
    error_message = "rto_minutes must be positive."
  }
}

variable "budget_limit_usd" {
  type        = number
  description = "Monthly AWS budget alert threshold."
  validation {
    condition     = var.budget_limit_usd > 0
    error_message = "budget_limit_usd must be positive."
  }
}

variable "budget_alert_emails" {
  type        = list(string)
  description = "Optional email addresses for AWS Budget notifications."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Additional resource tags."
  default     = {}
}

variable "user_data_template" {
  type        = string
  description = "Path to the host bootstrap template; the module injects its managed asset CDN origin."
}

variable "user_data_values" {
  type        = map(any)
  description = "Values for the host bootstrap template other than the managed asset CDN origin."
}

variable "bootstrap_files" {
  type        = map(string)
  description = "Base64-encoded runtime bootstrap files staged privately before instance creation."
}

variable "alarm_email" {
  type        = string
  description = "Optional SNS email subscription; empty keeps alarms without external email."
  default     = ""
}

variable "backup_bucket_name" { type = string }
variable "asset_bucket_name" { type = string }

variable "client_store_origin" {
  type        = string
  description = "Exact ComPress Successor store HTTPS origin allowed to read client assets."
  validation {
    condition     = can(regex("^https://[^/*]+$", var.client_store_origin))
    error_message = "client_store_origin must be one exact HTTPS origin without wildcard or path."
  }
}

variable "runtime_secret_parameter_name" {
  type        = string
  description = "SSM SecureString parameter name for SUCCESSOR_RUNTIME_SECRET; value never enters Terraform."
  default     = "/successor/staging/runtime-secret"
  validation {
    condition     = var.runtime_secret_parameter_name == "/successor/staging/runtime-secret"
    error_message = "runtime_secret_parameter_name must be the approved staging parameter path."
  }
}

variable "runtime_bearer_parameter_name" {
  type        = string
  description = "SSM SecureString parameter name for SUCCESSOR_RUNTIME_BEARER_TOKEN; value never enters Terraform."
  default     = "/successor/staging/runtime-bearer"
  validation {
    condition     = var.runtime_bearer_parameter_name == "/successor/staging/runtime-bearer"
    error_message = "runtime_bearer_parameter_name must be the approved staging parameter path."
  }
}

variable "control_secret_parameter_name" {
  type        = string
  description = "SSM SecureString parameter name for ALPHA_CONTROL_CLAIM_SECRET; value never enters Terraform."
  default     = "/successor/staging/alpha-control-secret"
  validation {
    condition     = var.control_secret_parameter_name == "/successor/staging/alpha-control-secret"
    error_message = "control_secret_parameter_name must be the approved staging parameter path."
  }
}

variable "site_url" {
  type        = string
  description = "Public Successor site URL exposed to the runtime."
  default     = "https://www.successorgame.com"
  validation {
    condition     = can(regex("^https://[^/*]+$", var.site_url))
    error_message = "site_url must be one exact HTTPS origin without a path or wildcard."
  }
}

variable "site_bucket_name" {
  type        = string
  description = "Private S3 bucket for immutable standalone site releases."
}

variable "site_aliases" {
  type        = list(string)
  description = "Optional CloudFront custom-domain aliases; Cloudflare remains outside Terraform."
  default     = []
  validation {
    condition     = alltrue([for alias in var.site_aliases : can(regex("^[A-Za-z0-9.-]+$", alias))])
    error_message = "site_aliases must contain DNS names only."
  }
}

variable "site_acm_certificate_domain_name" {
  type        = string
  description = "Optional us-east-1 ACM certificate domain to request; validation records are output, never Route 53 managed."
  default     = ""
}

variable "site_acm_certificate_arn" {
  type        = string
  description = "Optional validated us-east-1 ACM certificate ARN for CloudFront custom aliases."
  default     = ""
}

variable "game_websocket_path_pattern" {
  type        = string
  description = "Exact Colyseus upgrade path pattern; keep this aligned with the shard room URL."
  default     = "/open-desert/*"
}

variable "staging_readiness_path" {
  type        = string
  description = "Explicit cache-disabled staging readiness path preserved through the site distribution."
  default     = "/readyz"
  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]+$", var.staging_readiness_path))
    error_message = "staging_readiness_path must be an absolute URL path."
  }
}

variable "staging_readiness_cidr_blocks" {
  type        = list(string)
  description = "Optional explicitly approved staging CIDRs for direct readiness checks."
  default     = []
}
