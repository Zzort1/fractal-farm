#!/usr/bin/env bash
# Stage 3b: log groups, task definitions, and the worker service.
#
# Reuses the A2 ECS cluster (the A3 FAQ allows this without retagging it).
# Tasks run in the public subnets with public IPs, so they reach ECR, SQS and
# S3 without a NAT gateway — the same arrangement A2 proved.
set -euo pipefail
# Git Bash would otherwise rewrite "/ecs/..." into a Windows path before aws.exe sees it.
export MSYS_NO_PATHCONV=1

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
AWS="aws --profile $PROFILE --region $REGION"
CLUSTER=n5453313-a2-cluster
SUBNETS="subnet-05a3b8177138c8b14,subnet-075811427d5564cf9,subnet-04ca053dcbe5f49cc"
DEFAULT_SG=sg-078997505ad1c6bbc
LOG_TAGS='{"qut-username":"n5453313@qut.edu.au","purpose":"assessment 3"}'
TAGS='[{"key":"qut-username","value":"n5453313@qut.edu.au"},{"key":"purpose","value":"assessment 3"}]'

cd "$(dirname "$0")/.."

for group in /ecs/n5453313-fractal-api /ecs/n5453313-fractal-worker; do
  if $AWS logs describe-log-groups --log-group-name-prefix "$group" --query "logGroups[?logGroupName=='$group'] | length(@)" --output text | grep -q 1; then
    echo "== log group $group exists"
  else
    echo "== creating log group $group"
    $AWS logs create-log-group --log-group-name "$group" --tags "$LOG_TAGS"
  fi
  # Retention is not permitted for students (logs:PutRetentionPolicy denied); best effort.
  $AWS logs put-retention-policy --log-group-name "$group" --retention-in-days 14 2>/dev/null \
    || echo "   (retention policy not permitted — logs kept indefinitely)"
done

echo "== registering task definitions"
API_TD=$($AWS ecs register-task-definition --cli-input-json file://infra/ecs/api-taskdef.json \
  --query taskDefinition.taskDefinitionArn --output text)
WORKER_TD=$($AWS ecs register-task-definition --cli-input-json file://infra/ecs/worker-taskdef.json \
  --query taskDefinition.taskDefinitionArn --output text)
echo "   $API_TD"
echo "   $WORKER_TD"

if $AWS ecs describe-services --cluster "$CLUSTER" --services n5453313-fractal-worker \
     --query "services[?status=='ACTIVE'] | length(@)" --output text | grep -q 1; then
  echo "== worker service exists — rolling to $WORKER_TD"
  $AWS ecs update-service --cluster "$CLUSTER" --service n5453313-fractal-worker \
    --task-definition "$WORKER_TD" --force-new-deployment --query service.status --output text
else
  echo "== creating worker service"
  $AWS ecs create-service --cluster "$CLUSTER" --service-name n5453313-fractal-worker \
    --task-definition "$WORKER_TD" --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$DEFAULT_SG],assignPublicIp=ENABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=0" \
    --propagate-tags SERVICE --enable-ecs-managed-tags \
    --tags "$TAGS" --query service.status --output text
fi
