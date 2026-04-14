# This actually builds the .js files we use using tsc
FROM node:lts AS builder
WORKDIR /usr/src/app
COPY package*.json .
RUN npm ci
COPY . .
RUN npm run tsc

# This builds a slimmer version of the dependencies for running only.
FROM node:lts-slim
ENV NODE_ENV=prod
USER node
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /usr/src/app/build ./build
CMD ["node", "build/index.js"]
