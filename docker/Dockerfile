# Extends openclaw:local with experiment dependencies.
# Re-runs pnpm install so workspace extension deps (e.g. @vector-im/matrix-bot-sdk) are present,
# then installs openhive-cli for multi-agent coordination.
#
# Build: docker build -f docker/Dockerfile -t openclaw-agents:local .
FROM openclaw:local
WORKDIR /app

ENV CI=true
RUN pnpm install --frozen-lockfile

USER root
COPY docker/openhive-cli /tmp/openhive-cli
RUN pip install --no-cache-dir /tmp/openhive-cli
