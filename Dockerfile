# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && if [ -f /run/secrets/proxy_ca ]; then export APT_TLS='-o Acquire::https::CaInfo=/run/secrets/proxy_ca'; fi \
    && apt-get ${APT_TLS:-} -o Acquire::https::Proxy="${https_proxy:-${HTTPS_PROXY:-DIRECT}}" update \
    && apt-get ${APT_TLS:-} -o Acquire::https::Proxy="${https_proxy:-${HTTPS_PROXY:-DIRECT}}" install -y --no-install-recommends python3 git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_OPTIONS=--max-old-space-size=1024
USER node
CMD ["python3", "packaging/runtime.py"]
