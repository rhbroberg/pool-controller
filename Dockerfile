FROM node as builder
RUN mkdir -p /opt/pool-controller

ENV PATH /opt/node_modules/.bin:$PATH

WORKDIR /opt/pool-controller
COPY server/package.json server/package-lock.json* ./
RUN npm install && npm cache clean --force

FROM node:10-alpine

ENV NODE_ENV=docker-test
WORKDIR /opt/pool-controller
COPY --from=builder /opt/pool-controller/node_modules /opt/pool-controller/node_modules

COPY server /opt/pool-controller

CMD [ "node", "server.js", "-d", "serial", "-f", "/dev/ttyUSB0" ]

