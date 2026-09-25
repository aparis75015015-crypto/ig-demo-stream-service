FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV NODE_ENV=production PORT=3000 CACHE_FILE=/data/gold-candles.json
EXPOSE 3000
CMD ["npm", "start"]
