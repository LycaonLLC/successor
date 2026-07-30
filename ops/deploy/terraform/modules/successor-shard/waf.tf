resource "aws_wafv2_web_acl" "site" {
  provider = aws.us_east_1
  name     = "${var.name}-site"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "register-rate-limit"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/alpha-api/register"
            positional_constraint = "EXACTLY"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-register-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "login-rate-limit"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/alpha-api/login"
            positional_constraint = "EXACTLY"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-login-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "device-start-rate-limit"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 200
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/alpha-api/device/start"
            positional_constraint = "EXACTLY"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-device-start-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "device-poll-rate-limit"
    priority = 40
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 300
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/alpha-api/device/poll"
            positional_constraint = "EXACTLY"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-device-poll-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-common-rules"
    priority = 100
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 110
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-aws-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-site-waf"
    sampled_requests_enabled   = true
  }
}
