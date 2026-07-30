variable "aws_region" {
  type        = string
  description = "Explicit region for the Terraform state bucket and hosted zone."
}
variable "state_bucket_name" {
  type        = string
  description = "Globally unique, manually approved state bucket name."
}
variable "hosted_zone_name" {
  type        = string
  description = "Public DNS zone to delegate from the parent DNS provider."
  default     = "successor.compress.biz"
  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.hosted_zone_name))
    error_message = "hosted_zone_name must be a valid public DNS name."
  }
}
variable "tags" {
  type    = map(string)
  default = {}
}
