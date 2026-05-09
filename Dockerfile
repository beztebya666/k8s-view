# syntax=docker/dockerfile:1.7

# ───────────────────────────── 1) frontend build ─────────────────────────────
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
COPY internal/web/dist /go/internal/web/dist
RUN npm run build -- --outDir /go/internal/web/dist --emptyOutDir

# ───────────────────────────── 2) backend build ──────────────────────────────
FROM golang:1.22-alpine AS api
WORKDIR /go/src/k8s-view
ENV CGO_ENABLED=0 GOOS=linux GOFLAGS="-trimpath"
COPY go.mod ./
COPY go.sum* ./
RUN go mod download || true
COPY . .
COPY --from=web /go/internal/web/dist ./internal/web/dist
RUN go mod tidy
RUN go build -ldflags "-s -w -X main.version=$(date -u +%Y%m%d.%H%M)" -o /out/k8s-view ./cmd/k8sview

# ───────────────────────────── 3) runtime image ──────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 65532 app
USER app
WORKDIR /home/app
COPY --from=api /out/k8s-view /usr/local/bin/k8s-view
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/k8s-view"]
