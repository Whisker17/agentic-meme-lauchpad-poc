# OpenClaw with this repository's `mantle-meme` CLI built in. Build context: the repository root.
#   docker build -f docker/openclaw/Dockerfile -t mantle-meme-openclaw .
FROM ghcr.io/openclaw/openclaw:2026.10.6@sha256:7dbff0fe5f5359b1badefe90a23efa9f203cd0d3c36bee095f4896c7a1d3864b

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
# Agent turns run with `docker exec`, or in the OpenClaw gateway the launcher also runs when
# MANTLE_MEME_GATEWAY=1 (the Telegram demo, scripts/demo-up.sh). OpenClaw's exec tool kills every
# process a command leaves behind, so the main process is a launcher that runs `autopilot start` for
# the agent's `mantle-meme` (a wrapper): the daemon is the launcher's descendant, not OpenClaw's
# (skills/mantle-meme/README.md).
CMD ["node", "/opt/mantle-meme/docker/openclaw/launcher.mjs"]
