# syntax=docker/dockerfile:1.7
# Both build stages run on TARGETPLATFORM. The release lane is explicitly
# linux/amd64 so Cargo emits an x86_64 bridge, never an ARM binary copied into
# an amd64 runtime. Base images are digest pinned; no floating apt installs.
FROM --platform=$TARGETPLATFORM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS node-build
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64"
RUN npm install --global pnpm@10.33.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN pnpm install --frozen-lockfile --filter @successor/server... --filter @successor/client...
COPY server ./server
COPY client ./client
COPY tools/codegen/generated ./tools/codegen/generated
RUN pnpm --dir server build \
    && pnpm --dir client build \
    && pnpm --filter @successor/server --prod deploy --legacy /out/server \
    && cp -a server/dist /out/server/dist \
    && mkdir -p /out/server/scripts \
    && cp server/scripts/bugreports.mjs /out/server/scripts/bugreports.mjs \
    && mkdir -p /out/server/client/public \
    && cp -a client/public/successor-slice /out/server/client/public/

FROM --platform=$TARGETPLATFORM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4 AS rust-build
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64"
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY client/public/successor-slice ./client/public/successor-slice
COPY tools/denylist/denylist.txt ./tools/denylist/denylist.txt
RUN cargo build --locked --release -p successor-sim --example authority_bridge_server
RUN file target/release/examples/authority_bridge_server | grep -q "ELF 64-bit.*x86-64"

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64" \
    && groupadd --system --gid 10001 successor \
    && useradd --system --uid 10001 --gid successor --home-dir /var/lib/successor --create-home --shell /usr/sbin/nologin successor \
    && mkdir -p /app /var/lib/successor/state /tmp/successor \
    && chown -R successor:successor /app /var/lib/successor /tmp/successor

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=28093 \
    GAME_SHARD_ID=staging-synthetic \
    GAME_CHARACTER_STORE_PATH=/var/lib/successor/characters.json \
    GAME_SHARD_STATE_DIR=/var/lib/successor/state \
    GAME_RUST_AUTHORITY_BRIDGE_BIN=/app/bin/authority_bridge_server \
    GAME_SLICE_PATH=/app/client/public/successor-slice/open-desert-slice.json

COPY --from=node-build --chown=successor:successor /out/server/ ./
COPY --from=rust-build --chown=successor:successor /workspace/target/release/examples/authority_bridge_server ./bin/authority_bridge_server

USER successor
EXPOSE 28093
VOLUME ["/var/lib/successor", "/tmp"]
# Node is PID 1 and the existing server SIGTERM handler performs the save barrier.
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
