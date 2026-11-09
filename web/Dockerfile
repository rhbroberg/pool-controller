# distroless: Node and the app, with no package manager or shell, which leaves Docker Scout nearly
# nothing to find. Debian 13, since distroless's Debian 12 image lags behind Node 22's security
# releases.
FROM gcr.io/distroless/nodejs22-debian13

ENV NODE_ENV=production
ENV PORT=80
# the pool server, as docker-compose names it
ENV POOL_API_URL=http://pool:3000
WORKDIR /opt/pool-web

# no dependencies to install: the service uses only Node's own modules
COPY package.json server.js ./
COPY public ./public

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 80

# the image's entrypoint is node
CMD [ "server.js" ]
