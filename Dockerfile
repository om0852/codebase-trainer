# --- STAGE 1: Build TypeScript Distribution ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# --- STAGE 2: Production Container ---
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy built dist files and package manifests
COPY package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies only
RUN npm ci --only=production

# Symlink CLI binary
RUN npm link --only=production || true

# Set non-root security user
USER node

# Expose stdio for MCP server or CLI execution
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp"]
