# Build stage
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and prisma schema
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client and build TypeScript
RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy production dependencies and built source
COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Expose the API port
EXPOSE 3000

# Set environment variables (can be overridden by docker-compose)
ENV PORT=3000
ENV NODE_ENV=production

# Start the application with prisma sync
CMD ["sh", "-c", "npx prisma db push && npm start"]
