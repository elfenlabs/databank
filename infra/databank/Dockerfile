FROM pgvector/pgvector:pg17

# --- Install Bun ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /root/.bun/bin/bunx /usr/local/bin/bunx && \
    rm -rf /var/lib/apt/lists/*

# --- Install dbmate ---
RUN curl -fsSL -o /usr/local/bin/dbmate \
      https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-amd64 && \
    chmod +x /usr/local/bin/dbmate

# --- App setup ---
WORKDIR /app

# Install dependencies first (cache-friendly layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy app source and migrations
COPY src/ src/
COPY db/migrations/ db/migrations/

# Bake the pgvector init script
COPY infra/databank/init.sql /docker-entrypoint-initdb.d/init.sql

# Entrypoint
COPY infra/databank/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# PG env (hardcoded — internal use only)
ENV POSTGRES_DB=databank \
    POSTGRES_USER=databank \
    POSTGRES_PASSWORD=databank \
    DATABASE_URL=postgres://databank:databank@localhost:5432/databank?sslmode=disable

EXPOSE 4000

ENTRYPOINT ["/app/entrypoint.sh"]
