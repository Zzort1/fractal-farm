#!/usr/bin/env bash
# Stage 2: tile bucket and job queues.
#
# Every create call carries both tags: the account denies untagged creation,
# and tagging afterwards never gets the chance (see the A2 tagging notes).
# Safe to rerun — existing resources are reported, not recreated.
set -euo pipefail

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
AWS="aws --profile $PROFILE --region $REGION"
ACCOUNT=901444280953
USER_TAG="n5453313@qut.edu.au"
PURPOSE="assessment 3"

BUCKET=n5453313-fractal-tiles
QUEUE=n5453313-a3-render-queue
DLQ=n5453313-a3-render-dlq

echo "== S3 bucket $BUCKET"
if $AWS s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "   exists"
else
  $AWS s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration "LocationConstraint=$REGION,Tags=[{Key=qut-username,Value=$USER_TAG},{Key=purpose,Value=$PURPOSE}]" \
    --query Location --output text
fi
# The shorthand Tags=[...] above silently dropped "purpose" (the space in its
# value). s3control tag-resource merges, so applying both here is always safe.
$AWS s3control tag-resource --account-id "$ACCOUNT" --resource-arn "arn:aws:s3:::$BUCKET" \
  --tags "Key=qut-username,Value=$USER_TAG" "Key=purpose,Value=$PURPOSE"
# Private: tiles are only ever read through the API.
$AWS s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "== SQS dead-letter queue $DLQ"
DLQ_URL=$($AWS sqs create-queue --queue-name "$DLQ" \
  --attributes MessageRetentionPeriod=345600 \
  --tags "qut-username=$USER_TAG,purpose=$PURPOSE" \
  --query QueueUrl --output text)
DLQ_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$DLQ"
echo "   $DLQ_URL"

echo "== SQS render queue $QUEUE"
# Visibility 60 s: the heaviest tile renders in a few seconds, so a job is only
# redelivered if its worker genuinely died. Three receives, then dead-letter.
# Retention 1 h: a render nobody collected within an hour is not worth doing.
# Inline JSON: the Windows CLI cannot read Git Bash paths such as /tmp.
REDRIVE="{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}"
ATTRS="{\"VisibilityTimeout\":\"60\",\"MessageRetentionPeriod\":\"3600\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"RedrivePolicy\":\"$REDRIVE\"}"
QUEUE_URL=$($AWS sqs create-queue --queue-name "$QUEUE" \
  --attributes "$ATTRS" \
  --tags "qut-username=$USER_TAG,purpose=$PURPOSE" \
  --query QueueUrl --output text)
echo "   $QUEUE_URL"

echo "== verify tags"
$AWS s3api get-bucket-tagging --bucket "$BUCKET" --query "TagSet[].[Key,Value]" --output text 2>/dev/null \
  || $AWS s3control list-tags-for-resource --account-id "$ACCOUNT" \
       --resource-arn "arn:aws:s3:::$BUCKET" --query "Tags[].[Key,Value]" --output text
$AWS sqs list-queue-tags --queue-url "$QUEUE_URL" --output text
$AWS sqs list-queue-tags --queue-url "$DLQ_URL" --output text
