FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Node uses its bundled CA store for outbound HTTPS. Keep the image build free
# from Debian mirror availability by avoiding unnecessary OS package installs.

COPY package.json pnpm-lock.yaml ./

RUN corepack enable \
    && corepack prepare pnpm@10.20.0 --activate \
    && pnpm install --frozen-lockfile --prod

COPY . .

COPY scripts/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080

CMD ["/app/start.sh"]
