FROM node:22-bookworm-slim

ENV NODE_ENV=docker-test
WORKDIR /opt/pool-controller

# the package managers are needed only to install, and their own dependencies are where Docker
# Scout finds most of the image's vulnerabilities
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm

COPY server /opt/pool-controller

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 3000

CMD [ "node", "server.js", "-d", "serial", "-f", "/dev/ttyUSB0" ]
