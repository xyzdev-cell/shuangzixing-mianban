FROM node:24-trixie-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm prune --omit=dev
EXPOSE 3000
CMD [ "node", "dist/src/index.js" ]
