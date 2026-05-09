# k8s-view — convenience targets.
#
#   make frontend     build the React UI into internal/web/dist
#   make backend      build the Go binary (assumes frontend is already built)
#   make build        end-to-end build of a single binary
#   make run          build + run against $KUBECONFIG (default: ~/.kube/config)
#   make docker       build the multi-stage docker image
#   make docker-run   build + run with host networking for local k3s/kubeconfigs
#   make tidy         go mod tidy
#   make clean        rm bin/ and frontend dist/

BIN          ?= bin/k8s-view
GO           ?= go
NPM          ?= npm
VERSION      ?= v0.3.0
COMMIT       ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
LDFLAGS      ?= -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)
DOCKER_IMG   ?= ghcr.io/beztebya666/k8s-view:$(VERSION)

.PHONY: all build frontend backend run tidy clean docker docker-run helm helm-template

all: build

frontend:
	cd frontend && $(NPM) install --no-audit --no-fund
	cd frontend && $(NPM) run build

backend:
	$(GO) build -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/k8sview

build: frontend tidy backend

tidy:
	$(GO) mod tidy

run: build
	./$(BIN)

clean:
	rm -rf bin/
	rm -rf internal/web/dist/*
	touch  internal/web/dist/.gitkeep

docker:
	docker build -t $(DOCKER_IMG) .

docker-run: docker
	docker run --rm -it --network host --security-opt label=disable \
	  -v $(HOME)/.kube/config:/home/app/.kube/config:ro \
	  -e KUBECONFIG=/home/app/.kube/config \
	  $(DOCKER_IMG)

helm-template:
	helm template k8s-view ./deploy/helm

helm:
	helm install k8s-view ./deploy/helm \
	  --namespace k8s-view --create-namespace
