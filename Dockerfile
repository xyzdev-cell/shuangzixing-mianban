FROM node:24-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
ENV npm_config_build_from_source=true
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD [ "npm", "start" ]
