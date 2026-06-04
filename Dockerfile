# ============================================================
# Stage 1: Install dependencies (with build toolchain)
# ============================================================
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc ./
# 生产环境用 SiliconFlow API，不需要本地 fastembed(GPU)
# 跳过 onnxruntime-node 下载几百 MB 的 CUDA 包
ENV ONNXRUNTIME_NODE_SKIP_GPU=true
RUN corepack enable && pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

# ============================================================
# Stage 2: Build
# ============================================================
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build

# ============================================================
# Stage 3: Production runner (standalone)
# ============================================================
FROM node:22-alpine AS runner
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
