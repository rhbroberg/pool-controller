# The Raspberry Pi deployment, and the same stack with a simulated controller for trying it on a
# development machine. See README.md.

COMPOSE = docker compose

# the commit the images are built from, for the web page, the iOS app and GET /system/info to show
POOL_GIT_COMMIT ?= $(shell git describe --always --dirty 2>/dev/null || echo unknown)
export POOL_GIT_COMMIT

# a simulated controller, on ports that leave 80 and 443 to whatever already has them
SIM_HTTP_PORT ?= 8080
SIM_HTTPS_PORT ?= 8443
SIM_ENV = POOL_HTTP_PORT=$(SIM_HTTP_PORT) POOL_HTTPS_PORT=$(SIM_HTTPS_PORT) \
	POOL_JWT_SECRET=$${POOL_JWT_SECRET:-simulated-controller-only} POOL_HE_DDNS_KEY=$${POOL_HE_DDNS_KEY:-}
SIM = $(SIM_ENV) $(COMPOSE) -f docker-compose.yml -f docker-compose.sim.yml
SIM_LOCAL = $(SIM) -f docker-compose.local-certs.yml

# the name, and the CA, for trying a public certificate on a development machine
TEST_HOSTNAME ?= pooltest.brobasino.onthegrid.net
TEST_ACME_CA ?= https://acme-staging-v02.api.letsencrypt.org/directory

# linux/arm64 matches Raspberry Pi OS 64-bit (and Apple Silicon Docker Desktop). IMAGE_TAG is what
# Hub and compose use; override for a one-off (IMAGE_TAG=abc123 make push-rpi). BUILDX_OUTPUT is
# --load for the local docker store, or --push for Hub (see push-rpi).
IMAGE_TAG ?= latest
RPI_PLATFORM ?= linux/arm64
BUILDX_OUTPUT ?= --load

# production host for bind-mount debugging (override if needed)
DEBUG_HOST ?= rhb@gw.mystic.onthegrid.net
DEBUG_SSH_PORT ?= 32746
DEBUG_REMOTE ?= $(DEBUG_HOST):~/pool-controller
# include the Pi's ports overlay when present so caddy keeps its 8443 publish
COMPOSE_DEBUG = $(COMPOSE) -f docker-compose.yml \
	$(shell test -f docker-compose.ports.yml && echo -f docker-compose.ports.yml) \
	-f docker-compose.debug.yml

.PHONY: up up-pull pull down logs scout \
	build-rpi build-rpi-caddy build-rpi-web build-rpi-pool push-rpi \
	sim sim-letsencrypt sim-down sim-logs sim-root-cert \
	debug-pool debug-pool-off sync-debug

# --pull on the build, not on up, which pulls only the images services run and not the Dockerfiles'
# base images; fresh bases match what make scout checks
up:
	$(COMPOSE) build --pull
	$(COMPOSE) up -d

# run images already on Hub (after make push-rpi on a Mac); no local build
pull:
	$(COMPOSE) pull

up-pull: pull
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

# pool from ../server with Node inspector on 9229 (no image rebuild). Needs the secrets exported
# the same way as make up. Pair with sync-debug from a Mac.
debug-pool:
	$(COMPOSE_DEBUG) up -d pool
	@echo "inspector on :9229 — ssh -p $(DEBUG_SSH_PORT) -L 9229:127.0.0.1:9229 $(DEBUG_HOST)"

debug-pool-off:
	$(COMPOSE) up -d pool

# rsync local server/ (and the debug compose file) to the Pi and recreate the debug pool container
sync-debug:
	DEBUG_HOST=$(DEBUG_HOST) DEBUG_SSH_PORT=$(DEBUG_SSH_PORT) ./sync-debug.sh

# builds the images and fails on any critical or high CVE Docker Scout knows a fix for; the
# pre-commit hook runs it when a commit changes what goes into an image
scout:
	./scout-check.sh

# arm64 images for the Pi, built with buildx (works from macOS; Apple Silicon is native, Intel
# uses QEMU). --load puts them in the local store; push-rpi sends them to Docker Hub instead.
build-rpi: build-rpi-caddy build-rpi-web build-rpi-pool

build-rpi-caddy:
	docker buildx build --platform $(RPI_PLATFORM) --pull \
		-t rhbroberg/pool-caddy:$(IMAGE_TAG) \
		$(BUILDX_OUTPUT) ./caddy

build-rpi-web:
	docker buildx build --platform $(RPI_PLATFORM) --pull \
		-t rhbroberg/pool-web:$(IMAGE_TAG) \
		--build-arg POOL_GIT_COMMIT=$(POOL_GIT_COMMIT) \
		$(BUILDX_OUTPUT) ../web

build-rpi-pool:
	docker buildx build --platform $(RPI_PLATFORM) --pull \
		-t rhbroberg/pool-controller:$(IMAGE_TAG) \
		--build-arg POOL_GIT_COMMIT=$(POOL_GIT_COMMIT) \
		$(BUILDX_OUTPUT) ../server

# needs docker login; Hub then serves the arm64 images to make up-pull on the Pi
push-rpi: BUILDX_OUTPUT=--push
push-rpi: build-rpi

# https://localhost:8443 with a certificate from Caddy's own CA
sim:
	$(SIM_LOCAL) up -d --build

# https://$(TEST_HOSTNAME):8443 with a certificate from $(TEST_ACME_CA), Let's Encrypt's staging CA
# unless told otherwise; needs POOL_HE_DDNS_KEY
sim-letsencrypt:
	@test -n "$$POOL_HE_DDNS_KEY" || { echo "export POOL_HE_DDNS_KEY, the dynamic DNS key of _acme-challenge.$(TEST_HOSTNAME)" >&2; exit 1; }
	POOL_HOSTNAME=$(TEST_HOSTNAME) POOL_ACME_CA=$(TEST_ACME_CA) $(SIM) up -d --build

sim-down:
	$(SIM) down

sim-logs:
	$(SIM) logs -f

# the root of Caddy's own CA, for a browser, the Mac's keychain or a simulator to trust
sim-root-cert:
	$(SIM) cp caddy:/data/caddy/pki/authorities/local/root.crt caddy-local-root.crt
	@echo "wrote caddy-local-root.crt"
