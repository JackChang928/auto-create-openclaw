# Dockerfile — Hermes Agent（auto-create-openclaw 整合版本）
# Base: NousResearch Hermes Agent
FROM ghcr.io/nousresearch/hermes-agent:latest

# Install additional system dependencies
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    git \
    vim \
    && rm -rf /var/lib/apt/lists/*

# Create data directory structure
RUN mkdir -p /opt/data/{sessions,memories,skills,cron,hooks,logs,skins} && \
    chown -R hermes:hermes /opt/data

# Copy custom configuration if provided
COPY --chown=hermes:hermes entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Switch back to hermes user
USER hermes
WORKDIR /opt/data

# Environment defaults
ENV HERMES_GATEWAY_PORT=18790
ENV HERMES_WS_PORT=18791
ENV HERMES_LOG_LEVEL=INFO
ENV TZ=Asia/Taipei

# Ports
EXPOSE 18790 18791

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
