# Northvale Financial — Node 22 LTS on Alpine.
#
# better-sqlite3 is a native module with no musl prebuild, so it is compiled in a
# build stage. The compiler toolchain stays there and is not shipped.
# Source directories are copied explicitly: the host node_modules (glibc) must
# never overwrite the Alpine-compiled native module.
FROM node:22-alpine AS build
RUN apk upgrade --no-cache \
 && apk add --no-cache --virtual .build-deps build-base python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
# The date keys the build cache so this layer installs today's OS fixes; AppJet keeps it current on deploy.
RUN echo "os-refresh 2026-11-11" && apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
COPY --from=build /app ./
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
# The server binds 0.0.0.0 and reads process.env.PORT.
CMD ["node", "server/index.js"]
