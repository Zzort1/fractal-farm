#!/usr/bin/env bash
# Stage 5: the worker scaling controller, and a rollout of the other services.
#
# The scaler is a single long-running task: one controller, so there is never
# a disagreement about the desired count. If it stops, ECS restarts it, and
# the worker fleet simply keeps its last size in the meantime (fail static).
set -euo pipefail
export MSYS_NO_PATHCONV=1

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
awsc() { command aws --profile "$PROFILE" --region "$REGION" "$@" | tr -d "\r"; }
AWS=awsc
CLUSTER=n5453313-a2-cluster
SUBNETS="subnet-05a3b8177138c8b14,subnet-075811427d5564cf9,subnet-04ca053dcbe5f49cc"
DEFAULT_SG=sg-078997505ad1c6bbc
LOG_TAGS='{"qut-username":"n5453313@qut.edu.au","purpose":"assessment 3"}'
ECS_TAGS='[{"key":"qut-username","value":"n5453313@qut.edu.au"},{"key":"purpose","value":"assessment 3"}]'

cd "$(dirname "$0")/.."

GROUP=/ecs/n5453313-fractal-scaler
if ! $AWS logs describe-log-groups --log-group-name-prefix "$GROUP" --query "logGroups[?logGroupName=='$GROUP'] | length(@)" --output text | grep -q 1; then
  echo "== creating log group $GROUP"
  $AWS logs create-log-group --log-group-name "$GROUP" --tags "$LOG_TAGS"
fi

echo "== registering task definitions"
for family in api worker scaler; do
  ARN=$($AWS ecs register-task-definition --cli-input-json "file://infra/ecs/$family-taskdef.json" \
    --query taskDefinition.taskDefinitionArn --output text)
  echo "   $ARN"
  declare "TD_$family=$ARN"
done

roll() {
  local service="$1" td="$2"
  echo "== rolling $service → ${td##*/}"
  $AWS ecs update-service --cluster "$CLUSTER" --service "$service" --task-definition "$td" \
    --force-new-deployment --query service.status --output text
}

roll n5453313-fractal-api "$TD_api"
roll n5453313-fractal-worker "$TD_worker"

if $AWS ecs describe-services --cluster "$CLUSTER" --services n5453313-fractal-scaler \
     --query "services[?status=='ACTIVE'] | length(@)" --output text | grep -q 1; then
  roll n5453313-fractal-scaler "$TD_scaler"
else
  echo "== creating scaler service"
  $AWS ecs create-service --cluster "$CLUSTER" --service-name n5453313-fractal-scaler \
    --task-definition "$TD_scaler" --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$DEFAULT_SG],assignPublicIp=ENABLED}" \
    --deployment-configuration "maximumPercent=100,minimumHealthyPercent=0" \
    --propagate-tags SERVICE --enable-ecs-managed-tags \
    --tags "$ECS_TAGS" --query service.status --output text
fi
