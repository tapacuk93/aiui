#!/bin/sh
# Deploys the web version to https://aiui.oeaio.com.
#   deploy/deploy-web.sh             build web/ (+ prompts.json from the Swift prompts), create/update
#                                    the stack once the certificate is issued, sync, invalidate
#   deploy/deploy-web.sh --content   build, sync, invalidate only (what GitHub Actions runs)
# First run: deploy/request-cert.sh, wait until it prints ISSUED (a few minutes), then this.
set -eu
export AWS_REGION=us-east-1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST=$ROOT/build/webdist
STACK=aiui-web

# 0. syntax check (the full smoke test, tools/smoke/run.sh, needs a running app)
node --check "$ROOT/web/app.js" && node --check "$ROOT/web/backend.js" && node --check "$ROOT/web/qa.js"
node "$ROOT/tools/smoke/check-shims.mjs"

# 1. build: the web files plus the prompts generated from Sources/App/Prompts.swift
mkdir -p "$ROOT/build"
swiftc -o "$ROOT/build/export-prompts" "$ROOT/Sources/App/Prompts.swift" "$ROOT/tools/export-prompts/main.swift"
rm -rf "$DIST" && cp -R "$ROOT/web" "$DIST"
"$ROOT/build/export-prompts" "$DIST/prompts.json"

# 2. infrastructure (needs the issued certificate)
if [ "${1:-}" != "--content" ]; then
CERT=$(aws acm list-certificates --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='aiui.oeaio.com'].CertificateArn | [0]" --output text)
[ "$CERT" != "None" ] && [ -n "$CERT" ] || { echo "no ISSUED certificate yet - run deploy/request-cert.sh and wait" >&2; exit 1; }
aws cloudformation deploy --stack-name $STACK --template-file "$ROOT/deploy/stack.yaml" \
  --parameter-overrides CertificateArn="$CERT" --no-fail-on-empty-changeset
fi

# 3. upload (short cache: the files are not content-hashed) and invalidate
aws s3 sync "$DIST" s3://aiui-oeaio-site --delete --cache-control 'public, max-age=60' --only-show-errors
DIST_ID=$(aws cloudformation describe-stacks --stack-name $STACK \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' --query Invalidation.Id --output text >/dev/null
echo "deployed -> https://aiui.oeaio.com"
