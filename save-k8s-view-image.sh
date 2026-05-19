#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-k8s-view}"
IMAGE_TAG="${IMAGE_TAG:-v0.4.1}"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
OUT_DIR="${OUT_DIR:-dist}"
OUT_FILE="${OUT_FILE:-${OUT_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar}"

echo "[1/3] Check image ${IMAGE}..."
docker image inspect "${IMAGE}" >/dev/null

echo "[2/3] Save image to ${OUT_FILE}..."
mkdir -p "${OUT_DIR}"
docker save "${IMAGE}" -o "${OUT_FILE}"

echo "[3/3] Done"
ls -lh "${OUT_FILE}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUT_FILE}" > "${OUT_FILE}.sha256"
  echo "Checksum: ${OUT_FILE}.sha256"
fi

cat <<EOF

Copy ${OUT_FILE} to another machine, then run:

  docker load -i ${IMAGE_NAME}-${IMAGE_TAG}.tar
  docker run --rm -it \\
    --network host \\
    --security-opt label=disable \\
    -v "\${HOME}/.kube/config:/home/app/.kube/config:ro" \\
    ${IMAGE}

Open:

  http://localhost:8080
EOF
