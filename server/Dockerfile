# npm installs the dependencies in a builder; the image itself is distroless, with Node and the
# app but no package manager or shell, which leaves Docker Scout nearly nothing to find. Debian 13,
# since distroless's Debian 12 image lags behind Node 22's security releases.
FROM node:22-trixie-slim AS builder
WORKDIR /opt/pool-controller
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian13

ENV NODE_ENV=docker-test
WORKDIR /opt/pool-controller

COPY --from=builder /opt/pool-controller/node_modules ./node_modules
COPY . /opt/pool-controller

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 3000

# the image's entrypoint is node
CMD [ "server.js", "-d", "serial", "-f", "/dev/ttyUSB0" ]
