# syntax=docker/dockerfile:1.7
# Supply runtime=<verified-bundle> and customer-config=<reviewed-config-root> build contexts.
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
COPY src/job-store/ src/job-store/
COPY src/service-defaults/ src/service-defaults/
COPY src/session-host/ src/session-host/
RUN pnpm install --frozen-lockfile --filter @copilot-agent/session-host... \
    && pnpm --filter @copilot-agent/session-host... build \
    && pnpm --filter @copilot-agent/session-host --prod deploy --legacy /out

FROM ${NODE_IMAGE} AS session-host
WORKDIR /app
COPY --from=build /out/ /app/
COPY --from=build /copilot-agent-runtime-hybrid/src/sdk/nodejs/ /copilot-agent-runtime-hybrid/src/sdk/nodejs/
COPY --from=runtime /copilot-runtime /opt/shared-runtime/copilot-runtime
COPY --from=runtime /runtime.node /opt/shared-runtime/runtime.node
COPY --from=runtime /provenance.json /opt/shared-runtime/provenance.json
COPY --from=customer-config /harnesses /config/harnesses
COPY --from=customer-config /policy /config/policy
COPY execution-profiles /platform/execution-profiles
RUN mkdir /data && chown node:node /data \
    && chmod 0555 /opt/shared-runtime/copilot-runtime \
    && chmod 0444 /opt/shared-runtime/runtime.node
ENV NODE_ENV=production PORT=8080 CONFIG_ROOT=/config PLATFORM_ROOT=/platform \
    COPILOT_CLI_PATH=/opt/shared-runtime/copilot-runtime COPILOT_AHP_FACTORY_PROFILE=managed \
    SHARED_SESSION_DATA=/data
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]
