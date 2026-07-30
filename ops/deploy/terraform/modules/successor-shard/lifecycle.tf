resource "aws_ecr_lifecycle_policy" "server" {
  repository = aws_ecr_repository.server.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the newest bounded release set; operators protect active and rollback digests with protected-* tags."
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["release-"]
          countType     = "imageCountMoreThan"
          countNumber   = 1000
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Remove untagged build leftovers only."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    id     = "retain-current-assets"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
    expiration {
      days = 365
    }
  }
}
