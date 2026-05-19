#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="k8s-view"
IMAGE_TAG="v0.4.0"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
KUBECONFIG_PATH="${HOME}/.kube/config"

echo "[1/5] Check kubeconfig..."
test -f "${KUBECONFIG_PATH}" || { echo "ERROR: no ${KUBECONFIG_PATH}"; exit 1; }

echo "[2/5] Stop old k8s-view containers..."
docker ps -q --filter "ancestor=${IMAGE}" | xargs -r docker stop

echo "[3/5] Clean Docker..."
docker system prune -af

echo "[4/5] Build image ${IMAGE}..."
docker build -t "${IMAGE}" .

echo "[5/5] Run ${IMAGE}..."
docker run -d -it \
  --network host \
  --security-opt label=disable \
  -v "${KUBECONFIG_PATH}:/home/app/.kube/config:ro" \
  "${IMAGE}"
