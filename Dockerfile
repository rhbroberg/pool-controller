FROM node
EXPOSE 8080

RUN mkdir -p /opt/pool-controller

ENV PATH /opt/node_modules/.bin:$PATH
ENV NODE_ENV=docker-test

WORKDIR /opt
COPY server/package.json server/package-lock.json* ./
RUN npm install && npm cache clean --force

WORKDIR /opt/pool-controller
COPY server /opt/pool-controller

CMD [ "node", "server.js", "-d", "tail", "-f", "/tmp/in" ]
