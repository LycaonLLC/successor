data "aws_cloudfront_cache_policy" "site_cached" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "site_dynamic" {
  name = "Managed-CachingDisabled"
}

resource "aws_cloudfront_cache_policy" "site_api" {
  name        = "${var.name}-site-api-no-cache"
  default_ttl = 0
  max_ttl     = 1
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Authorization"] }
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
  }
}


resource "aws_s3_bucket" "site" {
  bucket = var.site_bucket_name
  tags   = merge(local.tags, { DataClass = "immutable-site" })
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site"
  description                       = "Private immutable standalone site releases"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "site_security" {
  name = "${var.name}-site-security"
  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self' wss:; form-action 'self'; upgrade-insecure-requests; frame-src https://${aws_cloudfront_distribution.assets.domain_name};"
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "site_dynamic" {
  name = "${var.name}-site-dynamic"
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-store, no-cache, must-revalidate"
      override = true
    }
  }
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "site_api" {
  name = "${var.name}-site-api"
  cookies_config {
    cookie_behavior = "whitelist"
    cookies { items = ["__Host-successor_session"] }
  }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Accept", "Content-Type", "Origin", "X-CSRF-Token", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"] }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_origin_request_policy" "site_game" {
  name = "${var.name}-site-game"
  cookies_config { cookie_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Accept", "Content-Type", "Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"] }
  }
  query_strings_config {
    query_string_behavior = "whitelist"
    query_strings { items = ["sessionId", "roomId", "token"] }
  }
}

resource "aws_cloudfront_origin_request_policy" "site_chat" {
  name = "${var.name}-site-chat"
  cookies_config { cookie_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Accept", "Content-Type", "Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"] }
  }
  query_strings_config {
    query_string_behavior = "whitelist"
    query_strings { items = ["ticket", "playerId", "userId", "displayName", "zoneId", "zone", "partyId", "guildId"] }
  }
}

resource "aws_cloudfront_function" "site_rewrite" {
  name    = "${var.name}-site-release-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';
  if (uri.indexOf('/alpha-api/') === 0 || uri.indexOf('/chat/') === 0 || uri.indexOf('/matchmake/') === 0 || uri === '${var.staging_readiness_path}' || uri.indexOf('${var.game_websocket_path_pattern}' .replace('*', '')) === 0) return request;
  if (uri === '/current.json') {
    request.uri = '/site/current.json';
    return request;
  }
  if (uri === '/') uri = '/index.html';
  else if (uri.endsWith('/')) uri += 'index.html';
  else if (!uri.split('/').pop().includes('.')) uri += '/index.html';
  request.uri = '/site/current' + uri;
  return request;
}
EOT
}

resource "aws_cloudfront_distribution" "site" {
  web_acl_id      = aws_wafv2_web_acl.site.arn
  enabled         = true
  aliases         = var.site_acm_certificate_arn == "" ? [] : var.site_aliases
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "site-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    domain_name = var.dns_name
    origin_id   = "successor-alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_cached.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/current.json"
    target_origin_id           = "site-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_rewrite.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = toset(["/client/release.json", "/beta/release.json"])
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "site-s3"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD", "OPTIONS"]
      cached_methods             = ["GET", "HEAD"]
      cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.site_security.id
      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.site_rewrite.arn
      }
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/alpha-api/*"
    target_origin_id           = "successor-alb"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.site_api.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.site_api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
  }

  ordered_cache_behavior {
    path_pattern               = "/chat/*"
    target_origin_id           = "successor-alb"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.site_chat.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
  }

  ordered_cache_behavior {
    path_pattern               = "/matchmake/*"
    target_origin_id           = "successor-alb"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.site_game.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
  }

  ordered_cache_behavior {
    path_pattern               = var.game_websocket_path_pattern
    target_origin_id           = "successor-alb"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.site_game.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
  }

  ordered_cache_behavior {
    path_pattern               = var.staging_readiness_path
    target_origin_id           = "successor-alb"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.site_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.site_game.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site_dynamic.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  dynamic "viewer_certificate" {
    for_each = var.site_acm_certificate_arn == "" ? [1] : []
    content { cloudfront_default_certificate = true }
  }
  dynamic "viewer_certificate" {
    for_each = var.site_acm_certificate_arn == "" ? [] : [var.site_acm_certificate_arn]
    content {
      acm_certificate_arn      = viewer_certificate.value
      minimum_protocol_version = "TLSv1.2_2021"
      ssl_support_method       = "sni-only"
    }
  }
  tags = local.tags
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = ["s3:GetObject"]
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })
}

resource "aws_acm_certificate" "site" {
  count                     = var.site_acm_certificate_domain_name == "" ? 0 : 1
  provider                  = aws.us_east_1
  domain_name               = var.site_acm_certificate_domain_name
  validation_method         = "DNS"
  subject_alternative_names = ["*.${var.site_acm_certificate_domain_name}"]
  lifecycle { create_before_destroy = true }
  tags = merge(local.tags, { DataClass = "site-certificate" })
}

output "site_acm_dns_validation_records" {
  value = var.site_acm_certificate_domain_name == "" ? {} : {
    for option in aws_acm_certificate.site[0].domain_validation_options : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  }
  sensitive = false
}
