#!/usr/bin/env bash
# Stage 1: read-only permissions probe for the CAB432 shared account.
#
# Lists and describes only — creates nothing. Each line reports whether this
# identity may call one API, so the design can avoid services the account's
# guardrails deny before anything is built on them.
#
#   bash infra/probe.sh            (needs: aws sso login --profile cab432)

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
AWS="aws --profile $PROFILE --region $REGION --output text"

probe() {
  local label="$1"; shift
  local out
  if out=$($AWS "$@" 2>&1); then
    printf "  %-44s OK\n" "$label"
  else
    local reason
    reason=$(echo "$out" | grep -oE "(AccessDenied[A-Za-z]*|UnauthorizedOperation|explicit deny|not authorized|OptInRequired|InvalidClientTokenId|[A-Za-z]+Exception)" | head -1)
    printf "  %-44s DENIED/ERR  %s\n" "$label" "${reason:-$(echo "$out" | head -1 | cut -c1-90)}"
  fi
}

echo "== identity"
$AWS sts get-caller-identity --query Arn

echo "== compute and containers"
probe "ecs list-clusters"                       ecs list-clusters
probe "ecs list-task-definitions"               ecs list-task-definitions --max-items 1
probe "ecr describe-repositories"               ecr describe-repositories --max-items 1
probe "application-autoscaling scalable-targets" application-autoscaling describe-scalable-targets --service-namespace ecs
probe "application-autoscaling scaling-policies" application-autoscaling describe-scaling-policies --service-namespace ecs
probe "autoscaling (EC2 ASG) describe"          autoscaling describe-auto-scaling-groups --max-items 1

echo "== messaging and storage"
probe "sqs list-queues"                         sqs list-queues --queue-name-prefix n5453313
probe "s3 list-buckets"                         s3api list-buckets --query "length(Buckets)"
probe "dynamodb list-tables"                    dynamodb list-tables --max-items 1
probe "sns list-topics"                         sns list-topics

echo "== caching"
probe "elasticache describe-serverless-caches"  elasticache describe-serverless-caches
probe "elasticache describe-cache-clusters"     elasticache describe-cache-clusters --max-items 1
probe "elasticache describe-cache-subnet-groups" elasticache describe-cache-subnet-groups --max-items 5
probe "cloudfront list-distributions"           cloudfront list-distributions --max-items 1
probe "cloudfront list-cache-policies"          cloudfront list-cache-policies --type managed --max-items 1
probe "cloudfront list-origin-access-controls"  cloudfront list-origin-access-controls --max-items 1

echo "== networking and edge"
probe "ec2 describe-vpcs"                       ec2 describe-vpcs
probe "ec2 describe-security-groups"            ec2 describe-security-groups --max-items 1
probe "elbv2 describe-load-balancers"           elbv2 describe-load-balancers --max-items 1
probe "route53 list-hosted-zones"               route53 list-hosted-zones
probe "acm list-certificates"                   acm list-certificates
probe "acm list-certificates (us-east-1)"       acm list-certificates --region us-east-1

echo "== observability, identity, config"
probe "cloudwatch list-metrics"                 cloudwatch list-metrics --namespace AWS/SQS --max-items 1
probe "cloudwatch list-dashboards"              cloudwatch list-dashboards
probe "logs describe-log-groups"                logs describe-log-groups --limit 1
probe "secretsmanager list-secrets"             secretsmanager list-secrets --max-results 1
probe "ssm describe-parameters"                 ssm describe-parameters --max-results 1
probe "cognito-idp list-user-pools"             cognito-idp list-user-pools --max-results 5
probe "apigatewayv2 get-apis"                   apigatewayv2 get-apis
probe "iam get-role (task role)"                iam get-role --role-name Task-Role-CAB432-ECS
probe "iam list-attached-role-policies (task)"  iam list-attached-role-policies --role-name Task-Role-CAB432-ECS
probe "resourcegroupstaggingapi get-resources"  resourcegroupstaggingapi get-resources --tag-filters Key=qut-username,Values=n5453313@qut.edu.au --max-items 1
