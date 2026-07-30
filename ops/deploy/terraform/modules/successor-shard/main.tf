locals {
  tags = merge({
    Project     = "Successor"
    Environment = "staging"
    Shard       = var.name
    ManagedBy   = "Terraform"
    Authority   = "rust-child-single-writer"
    RPOMinutes  = tostring(var.rpo_minutes)
    RTOMinutes  = tostring(var.rto_minutes)
  }, var.tags)
  bootstrap_revision = sha256(join("", [for name in sort(keys(var.bootstrap_files)) : "${name}:${sha256(var.bootstrap_files[name])}\n"]))
  user_data = templatefile(var.user_data_template, merge(var.user_data_values, {
    client_cdn_origin = "https://${aws_cloudfront_distribution.assets.domain_name}"
  }))
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_ami" "selected" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "image-id"
    values = [var.ami_id]
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.tags
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-public-${count.index + 1}" })
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = merge(local.tags, { Name = "${var.name}-private-${count.index + 1}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = 2
  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public[count.index].id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat" })
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]
  tags          = local.tags
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
  tags = merge(local.tags, { Name = "${var.name}-private" })
}

resource "aws_route_table_association" "private" {
  count          = 2
  route_table_id = aws_route_table.private.id
  subnet_id      = aws_subnet.private[count.index].id
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "CloudFront origin-facing ingress; readiness may be explicitly allowed."
  vpc_id      = aws_vpc.this.id
  ingress {
    description = "Public TLS for game, chat, and storefront origin"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "Public HTTP redirect"
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }
  dynamic "ingress" {
    for_each = var.staging_readiness_cidr_blocks
    content {
      description = "Explicit staging readiness access"
      protocol    = "tcp"
      from_port   = 443
      to_port     = 443
      cidr_blocks = [ingress.value]
    }
  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
  tags = local.tags
}

resource "aws_security_group" "instance" {
  name_prefix = "${var.name}-instance-"
  description = "Shard accepts only ALB health and WSS traffic; no SSH."
  vpc_id      = aws_vpc.this.id
  ingress {
    description     = "Game HTTP and WSS from ALB"
    protocol        = "tcp"
    from_port       = 28093
    to_port         = 28093
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_ecr_repository" "server" {
  name                 = "${var.name}/server"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  tags = local.tags
}

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = local.tags
}

resource "aws_iam_role_policy" "instance" {
  name = "${var.name}-runtime"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation", "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeVolumes", "ec2:DescribeTags"]
        Resource = "*"
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:volume/*"
        Condition = { StringEquals = { "aws:RequestTag/StateInitialized" = "true" } }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = "${aws_cloudwatch_log_group.shard.arn}:*"
      },
      {
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "Successor/${var.name}" } }
      },
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${var.runtime_secret_parameter_name}",
          "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${var.runtime_bearer_parameter_name}",
          "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${var.control_secret_parameter_name}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = aws_ecr_repository.server.arn
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = aws_s3_bucket.backup.arn
        Condition = { StringLike = { "s3:prefix" = ["state", "state/*", "bootstrap", "bootstrap/*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.backup.arn}/state/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.backup.arn}/bootstrap/*"
      }
    ]
  })
}

resource "aws_ebs_volume" "state" {
  lifecycle { prevent_destroy = true }
  availability_zone    = var.availability_zones[0]
  size                 = var.state_volume_size_gib
  type                 = "gp3"
  encrypted            = true
  multi_attach_enabled = false
  tags = merge(local.tags, {
    Name   = "${var.name}-state"
    Backup = "${var.name}-state"
  })
}

resource "aws_instance" "this" {
  lifecycle {
    precondition {
      condition     = data.aws_ami.selected.architecture == "x86_64"
      error_message = "ami_id must resolve to an x86_64 Amazon Linux image."
    }
    precondition {
      condition     = can(regex("^(t3|m5|m6i|c5|c6i|r5|r6i)\\.", var.instance_type))
      error_message = "instance_type must be an approved x86 family."
    }
  }
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = false
  ebs_optimized               = true
  user_data_base64            = base64gzip(local.user_data)
  depends_on                  = [aws_s3_object.bootstrap]
  user_data_replace_on_change = true
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 20
  }
  tags = merge(local.tags, { Name = var.name })
}

resource "aws_volume_attachment" "state" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.state.id
  instance_id = aws_instance.this.id
}

resource "aws_lb" "this" {
  name                       = substr(var.name, 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  idle_timeout               = 3600
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  tags                       = local.tags
}

resource "aws_lb_target_group" "this" {
  name        = substr("${var.name}-tg", 0, 32)
  port        = 28093
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.this.id
  health_check {
    enabled             = true
    path                = "/readyz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}

resource "aws_lb_target_group_attachment" "this" {
  target_group_arn = aws_lb_target_group.this.arn
  target_id        = aws_instance.this.id
  port             = 28093
}

resource "aws_acm_certificate" "this" {
  count             = var.game_acm_certificate_arn == "" ? 1 : 0
  domain_name       = var.dns_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
  tags = local.tags
}

resource "aws_route53_record" "certificate_validation" {
  for_each = var.game_acm_certificate_arn == "" && var.manage_route53_dns ? {
    for option in aws_acm_certificate.this[0].domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count                   = var.game_acm_certificate_arn == "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  lifecycle {
    precondition {
      condition     = var.manage_route53_dns || var.game_acm_certificate_arn != ""
      error_message = "game_acm_certificate_arn is required when manage_route53_dns is false."
    }
    precondition {
      condition     = !var.manage_route53_dns || var.route53_zone_id != ""
      error_message = "route53_zone_id is required when manage_route53_dns is true."
    }
  }
  certificate_arn = var.game_acm_certificate_arn != "" ? var.game_acm_certificate_arn : aws_acm_certificate_validation.this[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_route53_record" "alias" {
  count   = var.manage_route53_dns ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.dns_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = var.asset_bucket_name
  tags   = local.tags
}
resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_cors_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = [var.client_store_origin]
    allowed_headers = ["Content-Type", "Origin", "Accept"]
    expose_headers  = ["ETag", "Content-Length"]
    max_age_seconds = 86400
  }
}

resource "aws_cloudfront_response_headers_policy" "assets" {
  name = "${var.name}-assets-cors"
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers {
      items = ["Content-Type", "Origin", "Accept"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_origins {
      items = [var.client_store_origin]
    }
    access_control_expose_headers {
      items = ["ETag", "Content-Length"]
    }
    origin_override = true
  }
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${var.name}-assets"
  description                       = "Private immutable client assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_distribution" "assets" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = aws_s3_bucket.assets.id
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }
  default_cache_behavior {
    target_origin_id           = aws_s3_bucket.assets.id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.assets.id
    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  tags = local.tags
}
resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.assets.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.assets.arn } }
    }]
  })
}

resource "aws_s3_bucket" "backup" {
  bucket = var.backup_bucket_name
  tags   = merge(local.tags, { DataClass = "durable-backup" })
}
resource "aws_s3_object" "bootstrap" {
  for_each               = var.bootstrap_files
  bucket                 = aws_s3_bucket.backup.id
  key                    = "bootstrap/${local.bootstrap_revision}/${each.key}"
  content_base64         = each.value
  source_hash            = sha256(each.value)
  server_side_encryption = "AES256"
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_cloudwatch_log_group" "shard" {
  name              = "/successor/${var.name}"
  retention_in_days = 30
  tags              = local.tags
}
resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name}-cpu"
  alarm_description   = "Shard CPU alarm; investigate before replacing the stateful host."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  dimensions          = { InstanceId = aws_instance.this.id }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "status" {
  alarm_name          = "${var.name}-status-check"
  alarm_description   = "EC2 status check alarm; recovery is a human decision because EBS is single-writer."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  dimensions          = { InstanceId = aws_instance.this.id }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "ALB server errors."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix }
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}

resource "aws_iam_role" "dlm" {
  name = "${var.name}-dlm"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "dlm.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}
resource "aws_iam_role_policy" "dlm" {
  name = "${var.name}-dlm"
  role = aws_iam_role.dlm.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateSnapshot", "ec2:CreateSnapshots"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Backup" = "${var.name}-state" } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:DeleteSnapshot"]
        Resource  = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Shard" = var.name } }
      },
      {
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot/*"
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateSnapshot", "CreateSnapshots"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeTags"]
        Resource = "*"
      }
    ]
  })
}
resource "aws_dlm_lifecycle_policy" "state" {
  description        = "Successor state snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = "${var.name}-state" }
    schedule {
      name = "rpo-${var.rpo_minutes}-minutes"
      create_rule {
        interval      = max(1, ceil(var.rpo_minutes / 60))
        interval_unit = "HOURS"
      }
      retain_rule {
        count = 24
      }
      tags_to_add = merge(local.tags, { SnapshotType = "state" })
      copy_tags   = true
    }
  }
  tags = local.tags
}

resource "aws_budgets_budget" "monthly" {
  count        = length(var.budget_alert_emails) == 0 ? 0 : 1
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
