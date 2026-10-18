# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim
# The slim Node base has no CA bundle. Bootstrap using Debian's default
# signed APT repositories; switch to HTTPS once ca-certificates is installed.
# A managed build may supply a trusted CA to use HTTPS from the first request.
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -s /run/secrets/proxy_ca ]; then \
        sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
        export APT_TLS='-o Acquire::https::CaInfo=/run/secrets/proxy_ca'; \
    fi \
    && apt-get ${APT_TLS:-} -o Acquire::https::Proxy="${https_proxy:-${HTTPS_PROXY:-DIRECT}}" update \
    && apt-get ${APT_TLS:-} -o Acquire::https::Proxy="${https_proxy:-${HTTPS_PROXY:-DIRECT}}" install -y --no-install-recommends python3 git ca-certificates tzdata \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_OPTIONS=--max-old-space-size=1024
USER node
CMD ["python3", "packaging/runtime.py"]
