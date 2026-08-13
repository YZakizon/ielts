FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache su-exec && npm install --omit=dev

COPY index.html admin.html styles.css app.js admin.js account-plans.js subscription-service.js usage-service.js server.js ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
