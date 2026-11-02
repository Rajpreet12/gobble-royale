#!/usr/bin/env bash
# Ships a new version to the $5 Lightsail server.
# Zips server/, uploads it, and prints the one command to paste into the Lightsail browser SSH.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
BUCKET=$(aws cloudformation describe-stacks --region "$REGION" --stack-name gobble-royale-base \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucket'].OutputValue" --output text)
KEY="gobble-royale/lightsail-$(date +%Y%m%d-%H%M%S).zip"

ZIP="$(mktemp -d)/source.zip"
python - "$ZIP" <<'EOF'
import os, sys, zipfile
os.chdir("server")
files = ["package.json", "package-lock.json"]
for d in ("src", "public", "scripts"):
    files += [os.path.join(root, n) for root, _, names in os.walk(d) for n in names]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f.replace("\\", "/"))
EOF
aws s3 cp --region "$REGION" "$ZIP" "s3://$BUCKET/$KEY" --only-show-errors
URL=$(aws s3 presign --region "$REGION" "s3://$BUCKET/$KEY" --expires-in 3600)

echo
echo "Uploaded. Now open the Lightsail browser SSH:"
echo "  https://lightsail.aws.amazon.com/ls/webapp/us-east-1/instances/gobble-royale/connect"
echo "and paste this (the link works for 1 hour):"
echo
echo "  sudo gobble-update '$URL'"
