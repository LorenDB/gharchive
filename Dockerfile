FROM node:22-alpine AS base
RUN apk add --no-cache git

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/data

# su-exec: drop root → app after fixing volume ownership in entrypoint
RUN apk add --no-cache su-exec \
 && addgroup --system --gid 1001 app \
 && adduser --system --uid 1001 app \
 && mkdir -p /data \
 && chown -R app:app /data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Start as root so the entrypoint can chown bind-mounted /data, then su-exec app
EXPOSE 3000
ENV PORT=3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
