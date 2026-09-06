FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.ts"]
