#!/usr/bin/env bash
# Builds the game server image and ships it to Amazon ECS Express Mode.
# First run: creates the base stack and the service. Later runs: push a new image and update the service.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK=gobble-royale-base
SERVICE=gobble-royale

echo "1/4 Base stack (image repo, score table, roles)"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file infra/template.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

out() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
REPO=$(out RepositoryUri)
TABLE=$(out TableName)
EXEC_ROLE=$(out ExecutionRoleArn)
INFRA_ROLE=$(out InfrastructureRoleArn)
TASK_ROLE=$(out TaskRoleArn)
TAG=$(date +%Y%m%d-%H%M%S)

BUCKET=$(out SourceBucket)
PROJECT=$(out BuildProject)

# The image is built by CodeBuild in AWS, so you don't need Docker on your machine.
echo "2/4 Build $REPO:$TAG in CodeBuild"
ZIP="$(mktemp -d)/source.zip"
python - "$ZIP" <<'EOF'
import os, sys, zipfile
os.chdir("server")
files = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json"]
for d in ("src", "public"):
    files += [os.path.join(root, n) for root, _, names in os.walk(d) for n in names]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f.replace("\\", "/"))
EOF
aws s3 cp --region "$REGION" "$ZIP" "s3://$BUCKET/gobble-royale/source.zip" --only-show-errors
BUILD=$(aws codebuild start-build --region "$REGION" --project-name "$PROJECT" \
  --environment-variables-override "name=IMAGE_TAG,value=$TAG,type=PLAINTEXT" --query build.id --output text)
while :; do
  STATUS=$(aws codebuild batch-get-builds --region "$REGION" --ids "$BUILD" --query "builds[0].buildStatus" --output text)
  [ "$STATUS" != "IN_PROGRESS" ] && break
  sleep 10
done
[ "$STATUS" = "SUCCEEDED" ] || { echo "Build $STATUS. Logs: CodeBuild console, build $BUILD"; exit 1; }

CONTAINER=$(printf '{"image":"%s:%s","containerPort":8080,"environment":[{"name":"TABLE_NAME","value":"%s"}]}' "$REPO" "$TAG" "$TABLE")
# Each task runs its own arenas; the score table is shared, so a second or third task just means more fields.
SCALING='{"minTaskCount":1,"maxTaskCount":3}'

ARN=$(aws ecs describe-services --region "$REGION" --cluster default --services "$SERVICE" \
  --query "services[?status=='ACTIVE'].serviceArn | [0]" --output text 2>/dev/null || true)

if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "3/4 Creating the Express Mode service (takes about 5 minutes)"
  aws ecs create-express-gateway-service --region "$REGION" \
    --service-name "$SERVICE" \
    --execution-role-arn "$EXEC_ROLE" \
    --infrastructure-role-arn "$INFRA_ROLE" \
    --task-role-arn "$TASK_ROLE" \
    --primary-container "$CONTAINER" \
    --health-check-path /health \
    --cpu 512 --memory 1024 \
    --scaling-target "$SCALING" \
    --monitor-resources DEPLOYMENT --monitor-mode TEXT-ONLY
else
  echo "3/4 Updating $ARN"
  aws ecs update-express-gateway-service --region "$REGION" \
    --service-arn "$ARN" \
    --primary-container "$CONTAINER" \
    --scaling-target "$SCALING"
fi

echo "4/4 Done. Your game is at https://<service-url>.ecs.$REGION.on.aws (shown in the ECS console under the service)."
