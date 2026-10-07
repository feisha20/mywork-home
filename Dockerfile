# 固定基础镜像摘要，避免同名标签更新时让依赖层缓存全部失效。
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:eae779f20e0cdf264247f6f3b4e62510d91f168a615117ed38430ba295f55590

FROM ${NODE_BASE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# 下载缓存独立于镜像层保留；构建与运行阶段共用这一次依赖安装。
RUN --mount=type=cache,id=mywork-home-npm,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run build

FROM dependencies AS production-dependencies
RUN --mount=type=cache,id=mywork-home-npm,target=/root/.npm,sharing=locked \
    npm prune --omit=dev --offline --no-audit --no-fund

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 WORKBENCH_RUNTIME_DIR=/app/.runtime STATIC_DIR=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /app/.runtime && chown node:node /app/.runtime
USER node
EXPOSE 8787
CMD ["node", "dist-server/server/main.js"]
