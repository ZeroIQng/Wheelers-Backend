FROM node:20-bookworm-slim

ARG WORKSPACE

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npm run db:generate
RUN npm run build

ENV SERVICE_WORKSPACE="${WORKSPACE}"

EXPOSE 3000

CMD ["sh", "-lc", "npm -w \"$SERVICE_WORKSPACE\" run start"]
