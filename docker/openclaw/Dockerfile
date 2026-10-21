# OpenClaw with this repository's `mantle-meme` CLI built in. Build context: the repository root.
#   docker build -f docker/openclaw/Dockerfile -t mantle-meme-openclaw .
FROM ghcr.io/openclaw/openclaw:2026.10.5@sha256:f40d1e66fd14d8c5b49c832f4100f83b53fdc01f5108f7db11de38fd0ee6dbe5

# The base image's corepack home is root-owned; the image runs as `node`.
ENV COREPACK_HOME=/home/node/.cache/corepack
WORKDIR /opt/mantle-meme
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm build \
 && mkdir -p /home/node/.local/bin \
 && chmod +x packages/cli/dist/bin/mantle-meme.js \
 && chmod +x docker/openclaw/mantle-meme.mjs \
 && ln -s /opt/mantle-meme/docker/openclaw/mantle-meme.mjs /home/node/.local/bin/mantle-meme \
 && mantle-meme --help > /dev/null

WORKDIR /app
# Agent turns run with `docker exec`. OpenClaw's exec tool kills every process a command leaves
# behind, so the main process is a launcher that runs `autopilot start` for the agent's `mantle-meme`
# (a wrapper): the daemon is the launcher's descendant, not OpenClaw's (skills/mantle-meme/README.md).
CMD ["node", "/opt/mantle-meme/docker/openclaw/launcher.mjs"]
