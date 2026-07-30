resource "aws_sns_topic" "ops" {
  name = "${var.name}-ops"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "ops_email" {
  count     = try(trimspace(var.alarm_email), "") == "" ? 0 : 1
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "disk" {
  alarm_name          = "${var.name}-disk"
  alarm_description   = "CloudWatch disk usage; sustained pressure blocks the configured RTO."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "disk_used_percent"
  namespace           = "Successor/${var.name}"
  period              = 300
  statistic           = "Maximum"
  threshold           = 80
  dimensions          = { InstanceId = aws_instance.this.id, path = "/" }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "backup_age" {
  alarm_name          = "${var.name}-backup-age"
  alarm_description   = "Backup age exceeds configured RPO."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackupAgeMinutes"
  namespace           = "Successor/${var.name}"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.rpo_minutes
  dimensions          = { Shard = var.name }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "backup_failure" {
  alarm_name          = "${var.name}-backup-failure"
  alarm_description   = "Application-consistent backup upload failed."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackupSuccess"
  namespace           = "Successor/${var.name}"
  period              = 3600
  statistic           = "Minimum"
  threshold           = 1
  dimensions          = { Shard = var.name }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "restore_rto" {
  alarm_name          = "${var.name}-restore-rto"
  alarm_description   = "Measured restore duration exceeded configured RTO."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "RestoreDurationMinutes"
  namespace           = "Successor/${var.name}"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.rto_minutes
  dimensions          = { Shard = var.name }
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "authority_ready" {
  alarm_name          = "${var.name}-authority-ready"
  alarm_description   = "Hosted readiness signal is absent; Rust authority is not serving."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Ready"
  namespace           = "Successor/${var.name}"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  dimensions          = { Shard = var.name }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  tags                = local.tags
}
