FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data && addgroup -S bollocks && adduser -S bollocks -G bollocks && chown -R bollocks:bollocks /app
USER bollocks

ENV PORT=8100
# Deploy ref baked in at build time — /api/version reports it. The build
# context has no .git, so the deploy wrapper passes --build-arg GIT_SHA=…
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
EXPOSE 8100
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
