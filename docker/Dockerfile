# Extends openclaw:local (built from the openclaw repo) with extension dependencies
# that the upstream Dockerfile misses because it runs pnpm install before copying
# extensions/*/package.json.
#
# Build: docker build -t openclaw-agents:local .
# Or just: docker compose build (uses OPENCLAW_IMAGE=openclaw-agents:local in .env)
FROM openclaw:local
WORKDIR /app
# Re-run install so workspace extension deps (e.g. @vector-im/matrix-bot-sdk) are present.
# The lock file and all source are already in the image; this just links the missing packages.
# CI=true prevents pnpm from prompting for TTY when updating an existing modules directory.
ENV CI=true
RUN pnpm install --frozen-lockfile
