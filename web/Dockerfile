# distroless: Node and the app, with no package manager or shell, which leaves Docker Scout nearly
# nothing to find. Debian 13, since distroless's Debian 12 image lags behind Node 22's security
# releases. TypeScript is compiled in the builder so the image only carries JavaScript.
FROM node:22-trixie-slim AS builder
WORKDIR /opt/pool-web
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json server.ts ./
COPY public ./public
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian13

ENV NODE_ENV=production
ENV PORT=80
# the pool server, as docker-compose names it
ENV POOL_API_URL=http://pool:3000
WORKDIR /opt/pool-web

COPY --from=builder /opt/pool-web/server.js ./
COPY --from=builder /opt/pool-web/public ./public
COPY package.json ./

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 80

# the image's entrypoint is node
CMD [ "server.js" ]
