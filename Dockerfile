FROM node:22-bookworm-slim

ENV NODE_ENV=docker-test
WORKDIR /opt/pool-controller

COPY server/package.json server/package-lock.json* ./
RUN npm install && npm cache clean --force

COPY server /opt/pool-controller

CMD [ "node", "server.js", "-d", "serial", "-f", "/dev/ttyUSB0" ]
