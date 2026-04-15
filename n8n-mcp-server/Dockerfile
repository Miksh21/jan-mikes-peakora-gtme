FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/build ./build
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "build/index.js"]
