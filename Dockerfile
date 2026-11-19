# Numrati API for Google Cloud Run
FROM node:24-slim
WORKDIR /app

# Install packages first (this layer is cached when only the code changes)
COPY package*.json ./
RUN npm ci

# Build the TypeScript code into dist/, then remove the dev-only packages
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Cloud Run sends traffic to the port in $PORT (env.ts reads it)
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
