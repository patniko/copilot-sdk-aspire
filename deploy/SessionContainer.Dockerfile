# syntax=docker/dockerfile:1.7
# Resumable session container. Supply the runtime=<verified Linux bundle> build context; customer configuration is
# not packaged because each container receives its admitted harness snapshot from the ledger.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV CI=true npm_config_registry=${NPM_REGISTRY} npm_config_update_notifier=false
RUN npm install -g pnpm@10.34.5 --registry="${NPM_REGISTRY}" --no-audit --no-fund
WORKDIR /bundle
COPY --from=runtime / /bundle/
RUN sha256sum -c SHA256SUMS \
    && mkdir -p /copilot-agent-runtime-hybrid/src/sdk/nodejs \
    && tar -xzf sdk.tgz --strip-components=1 -C /copilot-agent-runtime-hybrid/src/sdk/nodejs \
    && cd /copilot-agent-runtime-hybrid/src/sdk/nodejs \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund --registry="${NPM_REGISTRY}"
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/ contracts/
COPY src/service-defaults/ src/service-defaults/
COPY src/harness-hosting/ src/harness-hosting/
COPY src/session-container/ src/session-container/
RUN pnpm install --frozen-lockfile --filter @copilot-agent/session-container... \
    && pnpm --filter @copilot-agent/session-container... build \
    && pnpm --filter @copilot-agent/session-container --prod deploy --legacy /out

FROM ${NODE_IMAGE} AS session-container
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 session \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data/execution --shell /bin/bash session \
 && mkdir -m 0711 /data
WORKDIR /app
COPY --from=build /out/ /app/
COPY --from=build /copilot-agent-runtime-hybrid/src/sdk/nodejs/ /copilot-agent-runtime-hybrid/src/sdk/nodejs/
COPY --from=runtime /copilot-runtime /opt/runtime/copilot-runtime
COPY --from=runtime /runtime.node /opt/runtime/runtime.node
COPY --from=runtime /provenance.json /opt/runtime/provenance.json
COPY tools /app/tools
RUN chmod 0555 /opt/runtime/copilot-runtime \
 && chmod 0444 /opt/runtime/runtime.node /opt/runtime/provenance.json \
 && chmod -R a+rX /app /copilot-agent-runtime-hybrid
# The supervisor starts as root only to run the agent loop as uid 10001; the controller drops every other capability.
ENV NODE_ENV=production COPILOT_CLI_PATH=/opt/runtime/copilot-runtime SESSION_CONTAINER_DATA=/data
EXPOSE 8080
ENTRYPOINT ["node", "dist/supervisor.js"]
