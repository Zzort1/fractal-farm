#!/usr/bin/env bash
# Stage 3a: ECR repositories, build, push.
#
#   bash infra/stage3-images.sh [tag]     (default tag: git short sha)
#
# Images are tagged with the commit they were built from as well as
# `latest`, so a task definition can pin an exact, reproducible build.
set -euo pipefail

PROFILE="${AWS_PROFILE:-cab432}"
REGION="ap-southeast-2"
AWS="aws --profile $PROFILE --region $REGION"
REGISTRY=901444280953.dkr.ecr.$REGION.amazonaws.com
TAGS='[{"Key":"qut-username","Value":"n5453313@qut.edu.au"},{"Key":"purpose","Value":"assessment 3"}]'
VERSION="${1:-$(git rev-parse --short HEAD)}"

cd "$(dirname "$0")/.."

for repo in n5453313-fractal-api n5453313-fractal-worker; do
  if $AWS ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
    echo "== ECR $repo exists"
  else
    echo "== creating ECR $repo"
    $AWS ecr create-repository --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true \
      --tags "$TAGS" --query repository.repositoryUri --output text
  fi
done

echo "== docker login"
# Docker Desktop's Windows credential helper fails on ECR tokens ("not
# implemented" / "stub received bad data" — seen in A2 too). Use a private
# Docker config with no helper, so the short-lived token is stored inline,
# and keep the user's global ~/.docker untouched. Contexts are copied so the
# CLI still finds the Docker Desktop engine.
export DOCKER_CONFIG="$HOME/.docker-ecr-n5453313"
mkdir -p "$DOCKER_CONFIG"
[ -d "$HOME/.docker/contexts" ] && cp -r "$HOME/.docker/contexts" "$DOCKER_CONFIG/" 2>/dev/null || true
CONTEXT=$(node -e "try{console.log(require(process.env.HOME+'/.docker/config.json').currentContext||'')}catch{console.log('')}")
# Even with no credsStore set, Windows Docker falls back to wincred, so skip
# `docker login` and write the basic-auth entry that login would have stored.
AUTH=$($AWS ecr get-login-password | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(Buffer.from('AWS:'+s.trim()).toString('base64')))")
echo "{\"auths\":{\"$REGISTRY\":{\"auth\":\"$AUTH\"}},\"currentContext\":\"$CONTEXT\"}" > "$DOCKER_CONFIG/config.json"
echo "   token stored in $DOCKER_CONFIG (expires in 12 h)"

build_push() {
  local name="$1" dockerfile="$2"
  docker build -q -f "$dockerfile" -t "$name:$VERSION" .
  for tag in "$VERSION" latest; do
    docker tag "$name:$VERSION" "$REGISTRY/$name:$tag"
    docker push -q "$REGISTRY/$name:$tag"
  done
}

build_push n5453313-fractal-api services/api/Dockerfile
build_push n5453313-fractal-worker services/worker/Dockerfile

echo "== pushed $VERSION"
for repo in n5453313-fractal-api n5453313-fractal-worker; do
  $AWS ecr describe-images --repository-name "$repo" \
    --query "sort_by(imageDetails,&imagePushedAt)[-1].[imageTags[0],imageTags[1],imageSizeInBytes]" --output text
done
