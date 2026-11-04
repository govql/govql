FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4000

CMD ["node", "--experimental-loader=@opentelemetry/instrumentation/hook.mjs", "--import", "./instrumentation.js", "server.js"]