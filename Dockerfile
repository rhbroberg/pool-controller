FROM node:22-bookworm-slim

ENV NODE_ENV=docker-test
WORKDIR /opt/pool-controller

COPY server/package.json server/package-lock.json ./
RUN npm ci && npm cache clean --force

COPY server /opt/pool-controller

# the image has no .git, so the commit it was built from comes in from the build
ARG POOL_GIT_COMMIT=unknown
ENV POOL_GIT_COMMIT=$POOL_GIT_COMMIT

EXPOSE 3000

CMD [ "node", "server.js", "-d", "serial", "-f", "/dev/ttyUSB0" ]
