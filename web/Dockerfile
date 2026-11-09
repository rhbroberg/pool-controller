FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=80
# the pool server, as docker-compose names it
ENV POOL_API_URL=http://pool:3000
WORKDIR /opt/pool-web

# no dependencies to install: the service uses only Node's own modules, so the package managers,
# and the vulnerabilities Docker Scout finds in their dependencies, can go
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

COPY package.json server.js ./
COPY public ./public

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 80

CMD [ "node", "server.js" ]
