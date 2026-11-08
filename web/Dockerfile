FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=80
# the pool server, as docker-compose names it
ENV POOL_API_URL=http://pool:3000
WORKDIR /opt/pool-web

# no dependencies to install: the service uses only Node's own modules
COPY package.json server.js ./
COPY public ./public

EXPOSE 80

CMD [ "node", "server.js" ]
