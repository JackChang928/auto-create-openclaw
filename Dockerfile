FROM node:20-alpine

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Expose default port (override via PORT env var)
EXPOSE 3000

USER appuser

CMD ["node", "server.js"]
