FROM node:24.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --silent --show-error https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz \
    && echo '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8  /tmp/gh.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install /tmp/gh_2.101.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_2.101.0_linux_amd64
RUN npm install --global @openai/codex@0.155.1 && npm cache clean --force
COPY entrypoint.mjs probe.mjs network-probe.mjs proxy-relay.mjs /opt/factory/
COPY roles /opt/factory/roles
RUN mkdir -p /workspace /output /secrets /proxy && chmod -R a-w /opt/factory
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/factory/entrypoint.mjs"]
