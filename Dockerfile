# syntax=docker/dockerfile:1.7

# Multi-arch by cross-compilation: the heavy build stages run natively on
# the builder ($BUILDPLATFORM) and Go cross-compiles to the requested
# $TARGETARCH, so `buildx --platform linux/amd64,linux/arm64` is fast and
# needs no qemu for the compile. Only the tiny final stage is per-arch.

# ───────────────────────────── 1) frontend build ─────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
COPY internal/web/dist /go/internal/web/dist
RUN npm run build -- --outDir /go/internal/web/dist --emptyOutDir

# ───────────────────────────── 2) backend build ──────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS api
WORKDIR /go/src/k8s-view
ENV CGO_ENABLED=0 GOFLAGS="-trimpath"
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=dev
COPY go.mod ./
COPY go.sum* ./
RUN go mod download || true
COPY . .
COPY --from=web /go/internal/web/dist ./internal/web/dist
RUN go mod tidy
RUN GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/k8s-view ./cmd/k8sview

# ───────────────────────────── 3) runtime image ──────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 65532 app
USER app
WORKDIR /home/app
COPY --from=api /out/k8s-view /usr/local/bin/k8s-view
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/k8s-view"]
