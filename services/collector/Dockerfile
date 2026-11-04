# syntax=docker/dockerfile:1
# 多阶段自包含构建：web 前端在容器内构建，宿主机无需 Node。
# 受限网络（拉不动 Docker Hub）可用 build-arg 覆写两个基础镜像为本机已有者，
# 例：docker compose build --build-arg WEB_IMAGE=<本地node镜像> --build-arg RUN_IMAGE=<同>
ARG WEB_IMAGE=node:20-alpine
ARG RUN_IMAGE=node:22-slim

FROM ${WEB_IMAGE} AS web-build
WORKDIR /web
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY packages/web/ ./
RUN npm run build

FROM ${RUN_IMAGE}
# sshpass 供受控 SSH 写操作（heal/router restart）；curl+ping 供探针
RUN apt-get update && apt-get install -y --no-install-recommends \
    sshpass openssh-client curl iputils-ping ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/collector/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY services/collector/tsconfig.json ./
COPY services/collector/src ./src
# 源码 import 路径是 ../core-src/*，packages/core 为唯一真相源
COPY packages/core/src ./core-src
COPY --from=web-build /web/dist ./web/dist

ENV NODE_ENV=production
EXPOSE 8898
CMD ["npx", "tsx", "src/index.ts"]
