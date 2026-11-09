# Caddy with the Hurricane Electric DNS module, so certificates are proved with a DNS TXT record
# and the host needs no inbound port for the CA
ARG CADDY_VERSION=2.11.9
ARG CADDY_DNS_HE_VERSION=v1.2.2
# newer than Caddy's own requirements, for fixes Docker Scout reports; drop each once Caddy
# requires that version itself
ARG GO_X_NET_VERSION=v0.62.0
ARG KLAUSPOST_COMPRESS_VERSION=v1.20.2

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_HE_VERSION
ARG GO_X_NET_VERSION
ARG KLAUSPOST_COMPRESS_VERSION
RUN xcaddy build --with github.com/caddy-dns/he@${CADDY_DNS_HE_VERSION} \
    --replace golang.org/x/net=golang.org/x/net@${GO_X_NET_VERSION} \
    --replace github.com/klauspost/compress=github.com/klauspost/compress@${KLAUSPOST_COMPRESS_VERSION}

FROM caddy:${CADDY_VERSION}
# musl's fix for CVE-2026-107891 is only in edge so far; take musl from there until the base's own
# release has 1.2.6-r6. Caddy itself is a static Go binary and doesn't load it.
RUN apk upgrade --no-cache \
    && apk upgrade --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/main \
        musl musl-utils
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile Caddyfile.local /etc/caddy/
