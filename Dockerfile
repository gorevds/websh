# Pinned to a specific minor so a base rebase can't silently move Python
# under us; 3.12 matches the upper end of the CI test matrix.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false websh

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py index.html websh.js ./
COPY assets/ ./assets/

# Writable home for the encrypted credential vault (websh.creds.json).
# WORKDIR is root-owned, so point the vault at a dir the websh user owns
# and expose it as a volume so saved credentials survive a container
# replacement.
RUN mkdir -p /data && chown websh:websh /data
VOLUME /data

USER websh

# The bundled cryptography wheel makes the encrypted credential vault
# available, but it stays OFF by default. Opt in at run time with
# `-e WEBSH_VAULT_ENABLE=1` (add `-v websh-data:/data` to persist the
# store across container replacement). WEBSH_CREDS_PATH points the store
# at the writable /data volume — the default cwd path is not writable here.
ENV PORT=8765 HOST=0.0.0.0 SESSION_TIMEOUT=300 MAX_SESSIONS=50 \
    WEBSH_CREDS_PATH=/data/websh.creds.json

EXPOSE 8765

CMD ["python3", "server.py"]
