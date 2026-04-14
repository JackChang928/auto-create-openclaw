FROM node:20-alpine

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Change ownership to non-root user
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

CMD ["node", "src/index.js"]