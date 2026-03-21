#!/usr/bin/env bash
set -e

REGION="${AWS_DEFAULT_REGION:-us-west-2}"

put_if_absent() {
  local name="$1" value="$2"
  if aws ssm get-parameter --name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "Parameter $name already exists — skipping."
  else
    aws ssm put-parameter \
      --name "$name" \
      --type SecureString \
      --value "$value" \
      --region "$REGION" \
      --no-overwrite
    echo "Created parameter $name."
  fi
}

put_if_absent "/cavewiki/mediawiki-secret-key" "$(openssl rand -hex 32)"
put_if_absent "/cavewiki/mediawiki-upgrade-key" "$(openssl rand -hex 8)"
put_if_absent "/cavewiki/origin-verify-secret"  "$(openssl rand -hex 16)"

echo "Done — all SSM parameters are in place."
