FROM ghcr.io/openclaw/openclaw:latest

# Switch to root to configure the entrypoint and dependencies
USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    ffmpeg \
    sudo \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Switch back to the non-root node user provided by the base image
USER node
WORKDIR /home/node

# Install uv for Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/node/.local/bin:${PATH}"

# OpenClaw gateway uses 18789
EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
