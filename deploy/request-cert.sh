#!/bin/sh
# Request (or find) the us-east-1 ACM certificate for aiui.oeaio.com and write its DNS validation
# record into the oeaio.com zone. Idempotent; prints the ARN and status (ISSUED after a few minutes).
set -eu
export AWS_REGION=us-east-1
DOMAIN=aiui.oeaio.com
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name oeaio.com \
  --query "HostedZones[?Name=='oeaio.com.'].Id" --output text | sed 's|/hostedzone/||')
ARN=$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
  ARN=$(aws acm request-certificate --domain-name $DOMAIN --validation-method DNS \
    --idempotency-token aiui1 --tags Key=project,Value=aiui --query CertificateArn --output text)
  sleep 10   # the validation record takes a moment to appear
fi
REC=$(aws acm describe-certificate --certificate-arn "$ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)
NAME=$(echo "$REC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Name"])')
VALUE=$(echo "$REC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Value"])')
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",
  \"ResourceRecordSet\":{\"Name\":\"$NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$VALUE\"}]}}]}" \
  --query ChangeInfo.Status --output text >/dev/null
echo "$ARN $(aws acm describe-certificate --certificate-arn "$ARN" --query Certificate.Status --output text)"
