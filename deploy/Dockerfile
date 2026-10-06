# syntax=docker/dockerfile:1.7
# Multi-stage build for the control-plane services and the agent executor.
# Registries are build arguments so builds work behind package proxies.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG CUSTOMER_CONFIG_DIR=.copilot-agent-workspace

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV CI=true \
    npm_config_registry=${NPM_REGISTRY} \
    npm_config_update_notifier=false
RUN npm install -g pnpm@10.34.5 --registry="${NPM_REGISTRY}" --no-audit --no-fund
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY contracts/package.json contracts/
COPY src/service-defaults/package.json src/service-defaults/
COPY src/job-store/package.json src/job-store/
COPY src/agent-api/package.json src/agent-api/
COPY src/job-dispatcher/package.json src/job-dispatcher/
COPY src/inference-gateway/package.json src/inference-gateway/
COPY src/agent-executor/package.json src/agent-executor/
COPY src/agent-host/package.json src/agent-host/
COPY src/harness-hosting/package.json src/harness-hosting/
COPY tests/package.json tests/
COPY configurator/package.json configurator/
RUN pnpm install --frozen-lockfile --filter "./contracts" --filter "./src/**"
COPY contracts contracts
COPY src src
RUN pnpm -r --filter "./contracts" --filter "./src/**" run build
RUN for service in agent-api job-dispatcher inference-gateway agent-executor harness-hosting agent-host; do \
      pnpm --filter "@copilot-agent/${service}" deploy --legacy --prod "/out/${service}" || exit 1; \
    done

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS service-base
ARG CUSTOMER_CONFIG_DIR
ENV NODE_ENV=production \
    CONFIG_ROOT=/config \
    PLATFORM_ROOT=/platform \
    PORT=8080
WORKDIR /app
COPY --chown=root:root ${CUSTOMER_CONFIG_DIR}/harnesses /config/harnesses
COPY --chown=root:root ${CUSTOMER_CONFIG_DIR}/policy /config/policy
COPY --chown=root:root execution-profiles /platform/execution-profiles
USER node
EXPOSE 8080
# Run node directly: the base image's shell entrypoint drops hyphenated variables such as
# services__job-dispatcher__http__0 that Aspire uses for service discovery.
ENTRYPOINT ["node", "dist/main.js"]

FROM service-base AS agent-api
COPY --from=build /out/agent-api /app

FROM service-base AS job-dispatcher
COPY --from=build /out/job-dispatcher /app

FROM service-base AS inference-gateway
COPY --from=build /out/inference-gateway /app

# ---------------------------------------------------------------------------
# Executor: runs as root only to launch each runner as the unprivileged `runner` user.
# Runners get a private workspace, a minimal environment, and no control-plane or provider credentials.
FROM ${NODE_IMAGE} AS agent-executor
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && for i in 0 1 2 3 4 5 6 7; do \
      id=$((10001 + i)); \
      groupadd --gid "${id}" "runner${i}"; \
      useradd --uid "${id}" --gid "${id}" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "runner${i}"; \
    done \
 && mkdir -m 0711 /work
# Customer Python agent toolchain, pinned and built into the image (never installed at job start).
COPY execution-profiles/python-agent/requirements.txt /opt/python-agent/requirements.txt
RUN python3 -m venv /opt/python-agent \
 && /opt/python-agent/bin/pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /opt/python-agent/requirements.txt \
 && COPILOT_CLI_EXTRACT_DIR=/opt/copilot-cli /opt/python-agent/bin/python -m copilot download-runtime \
 && chmod -R a+rX /opt/python-agent /opt/copilot-cli
COPY --from=build /out/agent-executor /app/src/agent-executor
COPY --from=build /out/harness-hosting /app/src/harness-hosting
COPY tools /app/tools
COPY execution-profiles /app/execution-profiles
RUN chmod -R a+rX /app
ENV NODE_ENV=production \
    PLATFORM_ROOT=/app \
    WORKSPACE_ROOT=/work \
    RUNNER_UID=10001 \
    RUNNER_GID=10001
WORKDIR /app/src/agent-executor
ENTRYPOINT ["node", "dist/main.js"]

FROM agent-executor AS agent-host
ARG CUSTOMER_CONFIG_DIR
COPY --from=build /out/agent-host /app/src/agent-host
COPY ${CUSTOMER_CONFIG_DIR}/harnesses /config/harnesses
COPY ${CUSTOMER_CONFIG_DIR}/policy /config/policy
RUN mkdir -m 0711 /data
ENV CONFIG_ROOT=/config \
    DEMO_HOST_DATA=/data
WORKDIR /app/src/agent-host
EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]

FROM agent-host AS agent-host-runtime
ARG DEMO_RUNTIME_DIR=.runtime-artifacts
COPY ${DEMO_RUNTIME_DIR}/copilot-runtime /opt/demo-runtime/copilot-runtime
COPY ${DEMO_RUNTIME_DIR}/runtime.node /opt/demo-runtime/runtime.node
RUN chmod 0555 /opt/demo-runtime/copilot-runtime \
 && chmod 0444 /opt/demo-runtime/runtime.node
ENV DEMO_HOST_RUNTIME_PATH=/opt/demo-runtime/copilot-runtime \
    DEMO_HOST_RUNTIME_PROVIDER=/opt/demo-runtime/runtime.node
