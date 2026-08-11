FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.html styles.css app.js server.js ./
RUN mkdir -p /data && chown -R node:node /app /data

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["npm", "start"]
