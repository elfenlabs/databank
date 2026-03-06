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

# Copy app source, migrations, and seeds
COPY src/ src/
COPY db/migrations/ db/migrations/
COPY db/seeds/ db/seeds/

# Bake the pgvector init script
COPY infra/thesauros/init.sql /docker-entrypoint-initdb.d/init.sql

# Entrypoint
COPY infra/thesauros/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# PG env (hardcoded — internal use only)
ENV POSTGRES_DB=thesauros \
    POSTGRES_USER=thesauros \
    POSTGRES_PASSWORD=thesauros \
    DATABASE_URL=postgres://thesauros:thesauros@localhost:5432/thesauros?sslmode=disable

EXPOSE 4000

ENTRYPOINT ["/app/entrypoint.sh"]
