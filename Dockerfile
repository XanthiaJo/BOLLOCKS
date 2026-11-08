FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data && addgroup -S bollocks && adduser -S bollocks -G bollocks && chown -R bollocks:bollocks /app
USER bollocks

ENV PORT=8100
EXPOSE 8100
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
