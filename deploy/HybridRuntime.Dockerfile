# syntax=docker/dockerfile:1.7
# Same pinned Linux build base as the runtime repository's toolbox.
FROM node@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0 AS build
ARG CONFIGURATION=fast
ARG BUILD_JOBS=4
WORKDIR /runtime
ADD runtime.tar /runtime/
ADD hosting.tar /hosting/
ADD mxc.tar /mxc/
COPY prepare-runtime-overrides.mjs /prepare-runtime-overrides.mjs
RUN git init --quiet && node /prepare-runtime-overrides.mjs
RUN --mount=type=cache,target=/root/.cache/bazel,sharing=locked \
    node --experimental-strip-types script/bazel.ts build --config="${CONFIGURATION}" --jobs="${BUILD_JOBS}" \
      //src/native/runtime:runtime //src/runtime-bin:copilot-runtime \
    && mkdir /out \
    && cp bazel-bin/src/native/runtime/runtime.node /out/runtime.node \
    && cp bazel-bin/src/runtime-bin/copilot-runtime /out/copilot-runtime \
    && chmod 0555 /out/copilot-runtime

FROM build AS qualify
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /qualification
COPY sdk.tgz provenance.json /out/
RUN npm install --omit=dev --no-audit --no-fund --registry="${NPM_REGISTRY}" /out/sdk.tgz \
    && npm pkg set type=module
COPY qualify-hybrid-runtime.mjs filesystem.ts /qualification/
ENV COPILOT_CLI_PATH=/out/copilot-runtime \
    COPILOT_AHP_FACTORY_PROFILE=managed
RUN node --experimental-strip-types qualify-hybrid-runtime.mjs \
    && cd /out && sha256sum copilot-runtime runtime.node sdk.tgz provenance.json > SHA256SUMS

FROM scratch AS bundle
COPY --from=qualify /out/ /
