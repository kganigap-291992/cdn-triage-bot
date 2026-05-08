FROM node:20-slim

RUN apt-get update && apt-get install -y \
  poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 4001

CMD ["npm", "start"]