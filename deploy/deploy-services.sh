#!/bin/sh
# Deploys shared.aiui.oeaio.com and users.aiui.oeaio.com: stack aiui-services (deploy/services.yaml).
#   deploy/deploy-services.sh --cert         request (or find) the ACM certificate for both names in
#                                            the stack's region and write its DNS validation records
#                                            into the oeaio.com zone; prints ARN and status
#   deploy/deploy-services.sh                test, package the Lambda code, create/update the stack
#                                            (needs the ISSUED certificate), smoke-check both hosts
#   deploy/deploy-services.sh --mirror-now   make the pending GitHub revisions now (no settle wait)
# Optional environment: AWS_REGION (default us-east-1), MIRROR_ENABLED=true|false, MIRROR_REPO,
# MIRROR_BRANCH, REVIEW_ENABLED=true|false (kept from the last deploy when unset).
# First run: --cert, wait until it prints ISSUED (a few minutes), then without arguments.
# The mirror token: aws secretsmanager create-secret --name aiui/github-mirror --secret-string <token>
# then MIRROR_ENABLED=true deploy/deploy-services.sh.
# The optional AI review of revisions: aws secretsmanager create-secret --name aiui/revision-review
#   --secret-string '{"provider":"anthropic","apiKey":"..."}'   (or {"provider":"aicoin","token":"..."})
# then REVIEW_ENABLED=true deploy/deploy-services.sh (bundles @anthropic-ai/sdk into the Lambda code).
set -eu
export AWS_REGION="${AWS_REGION:-us-east-1}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STACK=aiui-services
NAME1=shared.aiui.oeaio.com
NAME2=users.aiui.oeaio.com

find_cert() {
  aws acm list-certificates --certificate-statuses "$@" \
    --query "CertificateSummaryList[?DomainName=='$NAME1'].CertificateArn | [0]" --output text
}

if [ "${1:-}" = "--cert" ]; then
  mkdir -p "$ROOT/build"
  ZONE=$(aws route53 list-hosted-zones-by-name --dns-name oeaio.com \
    --query "HostedZones[?Name=='oeaio.com.'].Id" --output text | sed 's|/hostedzone/||')
  ARN=$(find_cert PENDING_VALIDATION ISSUED)
  if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
    ARN=$(aws acm request-certificate --domain-name $NAME1 --subject-alternative-names $NAME2 \
      --validation-method DNS --idempotency-token aiuisvc1 --tags Key=project,Value=aiui \
      --query CertificateArn --output text)
    sleep 10   # the validation records take a moment to appear
  fi
  aws acm describe-certificate --certificate-arn "$ARN" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output json |
  python3 -c 'import json,sys
recs = {r["Name"]: r["Value"] for r in json.load(sys.stdin) if r}
print(json.dumps({"Changes": [{"Action": "UPSERT", "ResourceRecordSet": {"Name": n, "Type": "CNAME", "TTL": 300,
  "ResourceRecords": [{"Value": v}]}} for n, v in recs.items()]}))' > "$ROOT/build/services-cert-dns.json" || {
    echo "could not read the validation records yet - run again" >&2; exit 1; }
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" \
    --change-batch "file://$ROOT/build/services-cert-dns.json" --query ChangeInfo.Status --output text >/dev/null
  echo "$ARN $(aws acm describe-certificate --certificate-arn "$ARN" --query Certificate.Status --output text)"
  exit 0
fi

if [ "${1:-}" = "--mirror-now" ]; then
  FN=$(aws cloudformation describe-stacks --stack-name $STACK \
    --query "Stacks[0].Outputs[?OutputKey=='MirrorFunction'].OutputValue" --output text)
  aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
    --payload '{"force":true}' "$ROOT/build/mirror-result.json" >/dev/null
  cat "$ROOT/build/mirror-result.json"; echo
  exit 0
fi

# 0. tests (the same handlers, in memory)
(cd "$ROOT/services" && node --test test/*.test.mjs) >/dev/null || { echo "tests failed - run: cd services && npm test" >&2; exit 1; }

# 1. the certificate
CERT=$(find_cert ISSUED)
[ "$CERT" != "None" ] && [ -n "$CERT" ] || { echo "no ISSUED certificate yet - run deploy/deploy-services.sh --cert and wait" >&2; exit 1; }

# 2. package: services/src is the Lambda code (the AWS SDK v3 comes with the runtime); with the AI
#    review, plus @anthropic-ai/sdk (the version services/package.json names)
BUNDLE=$ROOT/build/services-lambda
rm -rf "$BUNDLE" && mkdir -p "$BUNDLE" && cp -R "$ROOT/services/src/." "$BUNDLE/"
REVIEW=${REVIEW_ENABLED:-$(aws cloudformation describe-stacks --stack-name $STACK \
  --query "Stacks[0].Parameters[?ParameterKey=='ReviewEnabled'].ParameterValue | [0]" --output text 2>/dev/null || echo false)}
if [ "$REVIEW" = true ]; then
  SDK=$(node -p "require('$ROOT/services/package.json').optionalDependencies['@anthropic-ai/sdk']")
  (cd "$BUNDLE" && echo '{"private":true}' > package.json && npm install --omit=dev --no-audit --no-fund "@anthropic-ai/sdk@$SDK" >/dev/null)
fi
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ARTIFACTS=aiui-services-artifacts-$ACCOUNT
if ! aws s3api head-bucket --bucket "$ARTIFACTS" 2>/dev/null; then
  if [ "$AWS_REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$ARTIFACTS" >/dev/null
  else aws s3api create-bucket --bucket "$ARTIFACTS" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$ARTIFACTS" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
mkdir -p "$ROOT/build"
aws cloudformation package --template-file "$ROOT/deploy/services.yaml" --s3-bucket "$ARTIFACTS" \
  --s3-prefix services --output-template-file "$ROOT/build/services.packaged.yaml" >/dev/null

# 3. deploy
set -- CertificateArn="$CERT"
[ -n "${MIRROR_ENABLED:-}" ] && set -- "$@" MirrorEnabled="$MIRROR_ENABLED"
[ -n "${MIRROR_REPO:-}" ] && set -- "$@" MirrorRepo="$MIRROR_REPO"
[ -n "${MIRROR_BRANCH:-}" ] && set -- "$@" MirrorBranch="$MIRROR_BRANCH"
[ -n "${REVIEW_ENABLED:-}" ] && set -- "$@" ReviewEnabled="$REVIEW_ENABLED"
aws cloudformation deploy --stack-name $STACK --template-file "$ROOT/build/services.packaged.yaml" \
  --capabilities CAPABILITY_IAM --parameter-overrides "$@" --tags project=aiui --no-fail-on-empty-changeset

# 4. smoke check (DNS can take a minute the first time)
for url in "https://$NAME1/v1/index?limit=1" "https://$NAME2/v1/find?q=aiui"; do
  printf '%s -> ' "$url"; curl -s -o /dev/null -w '%{http_code}\n' "$url" || echo unreachable
done
echo "deployed -> https://$NAME1 https://$NAME2"
