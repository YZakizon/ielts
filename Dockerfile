FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.html styles.css app.js server.js ./

EXPOSE 80

CMD ["npm", "start"]
