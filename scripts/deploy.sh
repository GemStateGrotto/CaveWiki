#!/usr/bin/env bash
set -e

required_vars=(
  CAVEWIKI_DOMAIN
  CAVEWIKI_HOSTED_ZONE_ID
  CAVEWIKI_HOSTED_ZONE_NAME
  CAVEWIKI_CERTIFICATE_ARN
)

for var in "${required_vars[@]}"; do
  if [[ -z "${!var}" ]]; then
    echo "Error: required environment variable $var is not set." >&2
    exit 1
  fi
done

cd "$(dirname "$0")/../cdk"

npx cdk deploy --all --require-approval never \
  --context "domainName=${CAVEWIKI_DOMAIN}" \
  --context "hostedZoneId=${CAVEWIKI_HOSTED_ZONE_ID}" \
  --context "hostedZoneName=${CAVEWIKI_HOSTED_ZONE_NAME}" \
  --context "certificateArn=${CAVEWIKI_CERTIFICATE_ARN}" \
  --context "originRecordName=${CAVEWIKI_ORIGIN_RECORD_NAME:-origin}"
