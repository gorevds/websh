# Pinned to a specific minor so a base rebase can't silently move Python
# under us; 3.12 matches the upper end of the CI test matrix.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false websh

WORKDIR /app
COPY server.py index.html websh.js ./
COPY assets/ ./assets/

USER websh

ENV PORT=8765 HOST=0.0.0.0 SESSION_TIMEOUT=300 MAX_SESSIONS=50

EXPOSE 8765

CMD ["python3", "server.py"]
