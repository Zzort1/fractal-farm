#!/usr/bin/env bash
# Stage 4: the public HTTPS entry point and the API service behind it.
#
#   Route 53  n5453313-fractal.cab432.com  (alias)
#     → ALB n5453313-a3-alb  :443 TLS (ACM), :80 → 301 to HTTPS
#       → target group n5453313-a3-api-tg  (IP targets, :8080, GET /healthz)
#         → ECS service n5453313-fractal-api  (Fargate tasks register themselves)
#
# The ALB is the dispatcher-push half of the design: it spreads requests over
# however many API tasks exist. Workers never sit behind it — they pull.
set -euo pipefail
export MSYS_NO_PATHCONV=1

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
# aws.exe on Windows ends text output with CRLF; strip the CR so captured
# values compare cleanly ("None" rather than "None\r").
awsc() { command aws --profile "$PROFILE" --region "$REGION" "$@" | tr -d "\r"; }
AWS=awsc
CLUSTER=n5453313-a2-cluster
VPC=vpc-007bab53289655834
SUBNETS="subnet-05a3b8177138c8b14 subnet-075811427d5564cf9 subnet-04ca053dcbe5f49cc"
SUBNETS_CSV="${SUBNETS// /,}"
DEFAULT_SG=sg-078997505ad1c6bbc
PUBLIC_SG=sg-032bd1ff8cf77dbb9
ZONE=Z02680423BHWEVRU2JZDQ
DOMAIN=n5453313-fractal.cab432.com
TAGS='[{"Key":"qut-username","Value":"n5453313@qut.edu.au"},{"Key":"purpose","Value":"assessment 3"}]'
ECS_TAGS='[{"key":"qut-username","value":"n5453313@qut.edu.au"},{"key":"purpose","value":"assessment 3"}]'

echo "== certificate for $DOMAIN"
# The CLI paginates and applies --query per page, so pick the ARN out of the text.
CERT=$($AWS acm list-certificates --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" \
  --output text | grep -o 'arn:[^[:space:]]*' | head -1 || true)
if [ -z "$CERT" ]; then
  CERT=$($AWS acm request-certificate --domain-name "$DOMAIN" --validation-method DNS \
    --tags "$TAGS" --query CertificateArn --output text)
  echo "   requested $CERT"
  sleep 8
fi
STATUS=$($AWS acm describe-certificate --certificate-arn "$CERT" --query Certificate.Status --output text)
if [ "$STATUS" != "ISSUED" ]; then
  read -r RNAME RVALUE <<<"$($AWS acm describe-certificate --certificate-arn "$CERT" \
    --query "Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]" --output text)"
  echo "   validation record $RNAME"
  $AWS route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$RNAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$RVALUE\"}]}}]}" \
    --query ChangeInfo.Status --output text
  echo "   waiting for issue..."
  $AWS acm wait certificate-validated --certificate-arn "$CERT"
fi
echo "   ISSUED $CERT"

echo "== target group"
TG=$($AWS elbv2 describe-target-groups --names n5453313-a3-api-tg --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || true)
if [ -z "$TG" ] || [ "$TG" = "None" ]; then
  TG=$($AWS elbv2 create-target-group --name n5453313-a3-api-tg --protocol HTTP --port 8080 \
    --vpc-id "$VPC" --target-type ip --health-check-path /healthz \
    --health-check-interval-seconds 10 --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --tags "$TAGS" --query "TargetGroups[0].TargetGroupArn" --output text)
fi
# Short drain: tile requests are brief, so a leaving task need not linger.
$AWS elbv2 modify-target-group-attributes --target-group-arn "$TG" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=15 >/dev/null
echo "   $TG"

echo "== load balancer"
ALB=$($AWS elbv2 describe-load-balancers --names n5453313-a3-alb --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || true)
if [ -z "$ALB" ] || [ "$ALB" = "None" ]; then
  ALB=$($AWS elbv2 create-load-balancer --name n5453313-a3-alb --type application --scheme internet-facing \
    --subnets $SUBNETS --security-groups "$PUBLIC_SG" "$DEFAULT_SG" \
    --tags "$TAGS" --query "LoadBalancers[0].LoadBalancerArn" --output text)
  $AWS elbv2 wait load-balancer-available --load-balancer-arns "$ALB"
fi
read -r ALB_DNS ALB_ZONE <<<"$($AWS elbv2 describe-load-balancers --load-balancer-arns "$ALB" \
  --query "LoadBalancers[0].[DNSName,CanonicalHostedZoneId]" --output text)"
echo "   $ALB_DNS"

echo "== listeners"
if ! $AWS elbv2 describe-listeners --load-balancer-arn "$ALB" --query "Listeners[?Port==\`443\`].ListenerArn" --output text | grep -q arn; then
  $AWS elbv2 create-listener --load-balancer-arn "$ALB" --protocol HTTPS --port 443 \
    --certificates CertificateArn="$CERT" --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --default-actions Type=forward,TargetGroupArn="$TG" --tags "$TAGS" --query "Listeners[0].Port" --output text
fi
if ! $AWS elbv2 describe-listeners --load-balancer-arn "$ALB" --query "Listeners[?Port==\`80\`].ListenerArn" --output text | grep -q arn; then
  $AWS elbv2 create-listener --load-balancer-arn "$ALB" --protocol HTTP --port 80 \
    --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
    --tags "$TAGS" --query "Listeners[0].Port" --output text
fi

echo "== DNS $DOMAIN → ALB"
$AWS route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch \
  "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"$ALB_ZONE\",\"DNSName\":\"dualstack.$ALB_DNS\",\"EvaluateTargetHealth\":false}}}]}" \
  --query ChangeInfo.Status --output text

echo "== API service"
API_TD=$($AWS ecs describe-task-definition --task-definition n5453313-fractal-api --query taskDefinition.taskDefinitionArn --output text)
if $AWS ecs describe-services --cluster "$CLUSTER" --services n5453313-fractal-api \
     --query "services[?status=='ACTIVE'] | length(@)" --output text | grep -q 1; then
  echo "   exists — rolling to $API_TD"
  $AWS ecs update-service --cluster "$CLUSTER" --service n5453313-fractal-api \
    --task-definition "$API_TD" --force-new-deployment --query service.status --output text
else
  $AWS ecs create-service --cluster "$CLUSTER" --service-name n5453313-fractal-api \
    --task-definition "$API_TD" --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS_CSV],securityGroups=[$DEFAULT_SG],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG,containerName=api,containerPort=8080" \
    --health-check-grace-period-seconds 30 \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
    --propagate-tags SERVICE --enable-ecs-managed-tags \
    --tags "$ECS_TAGS" --query service.status --output text
fi

echo "== done: https://$DOMAIN/"
