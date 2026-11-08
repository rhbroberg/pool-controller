# Caddy with the Hurricane Electric DNS module, so certificates are proved with a DNS TXT record
# and the host needs no inbound port for the CA
ARG CADDY_VERSION=2.11.9
ARG CADDY_DNS_HE_VERSION=v1.2.2

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_HE_VERSION
RUN xcaddy build --with github.com/caddy-dns/he@${CADDY_DNS_HE_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile Caddyfile.local /etc/caddy/
