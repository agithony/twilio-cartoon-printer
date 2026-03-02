FROM node:20-bullseye-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        cups-client \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./

RUN corepack enable \
    && corepack prepare pnpm@9.15.1 --activate \
    && pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 80

CMD ["node", "index.js"]
