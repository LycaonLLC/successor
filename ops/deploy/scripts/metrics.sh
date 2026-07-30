#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}"
REGION=${AWS_REGION:?AWS_REGION is required}
TOKEN=$(curl -fsS -X PUT --max-time 2 -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
INSTANCE_ID=$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || printf 'unknown')
DISK_USED=$(df --output=pcent /var/lib/successor | tail -n1 | tr -dc '0-9')
READY=0
curl -fsS --max-time 3 http://127.0.0.1:28093/readyz >/dev/null 2>&1 && READY=1 || true
LATEST_BACKUP=$(find /var/backups/successor -maxdepth 1 -type f -name '*.tar.gz' -printf '%T@\n' 2>/dev/null | sort -nr | head -n1 || true)
AGE=999999
if [[ -n "$LATEST_BACKUP" ]]; then AGE=$(awk -v now="$(date +%s)" -v then="$LATEST_BACKUP" 'BEGIN { print int((now-then)/60) }'); fi
aws cloudwatch put-metric-data --region "$REGION" --namespace "$NAMESPACE" --metric-data \
  "MetricName=disk_used_percent,Dimensions=[{Name=InstanceId,Value=$INSTANCE_ID},{Name=path,Value=/}],Value=$DISK_USED,Unit=Percent" \
  "MetricName=Ready,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=$READY,Unit=Count" \
  "MetricName=BackupAgeMinutes,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=$AGE,Unit=Count" \
  --no-cli-pager
