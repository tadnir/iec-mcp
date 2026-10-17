# The stdio MCP server, with its sign-in page on 8766. See "Hosting one
# long-lived copy" in README.md.
FROM docker.io/library/node:22.22.0-bookworm-slim

ENV NODE_ENV=production \
    IEC_CONFIG_DIR=/data \
    IEC_LOGIN_HOST=0.0.0.0

WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies too: the server runs its TypeScript through tsx.
RUN npm ci --include=dev && npm cache clean --force

COPY src src
COPY tsconfig.json ./

# Any user works; give it a writable /data.
USER 1000:1000
EXPOSE 8766
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
