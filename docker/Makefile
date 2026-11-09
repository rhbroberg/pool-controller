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

.PHONY: up down logs sim sim-letsencrypt sim-down sim-logs sim-root-cert

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

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
