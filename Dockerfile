FROM node:22-slim

# Install build dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json package-lock.json ./

# Install dependencies (compiles better-sqlite3 for Linux inside the container)
RUN npm ci --production

# Copy application source
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Environment defaults (override with -e or .env)
ENV PORT=3000
ENV ADMIN_PASSWORD=admin123
ENV JWT_SECRET=change_this_to_a_secret_with_32_chars_min
ENV DEMO_MODE=true
ENV DATA_FILE=/app/data/trading_brain.db

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
