locals {
  tags = merge({ Purpose = "terraform-state" }, var.tags)
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
  tags   = local.tags
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "retain-state-history"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 3650 }
  }
}

resource "aws_route53_zone" "successor" {
  name          = var.hosted_zone_name
  comment       = "Successor invite-alpha public delegation; parent DNS must delegate returned name servers."
  force_destroy = false
  tags          = merge(local.tags, { Purpose = "successor-public-dns" })
}
