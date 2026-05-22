# ============================================================
# Stage 1: Install dependencies (with build toolchain)
# ============================================================
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# 只用 pnpm-lock，避免 package-lock 干扰
COPY pnpm-lock.yaml ./
RUN corepack enable && pnpm fetch

COPY package.json ./
RUN corepack enable && pnpm install --offline --frozen-lockfile

# ============================================================
# Stage 2: Build
# ============================================================
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build

# ============================================================
# Stage 3: Production runner (standalone)
# ============================================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# public 资源 & 静态生成文件
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next.js standalone 产物
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs
EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
