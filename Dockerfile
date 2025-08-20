FROM denoland/deno:alpine AS builder

WORKDIR /usr/app

# Copy configuration files
COPY ./deno.json .
COPY ./deno.lock .
COPY ./package.json .

RUN deno install

# Copy source code
COPY ./src ./src

RUN deno task build

FROM denoland/deno:alpine AS runner

COPY --from=builder /usr/app/dist/bull-board /usr/local/bin/bull-board

# Environment variables
ENV NODE_ENV=production
ENV REDIS_HOST=localhost
ENV REDIS_PORT=6379
ENV REDIS_USE_TLS=false
ENV REDIS_IS_CLUSTER=false
ENV BULL_PREFIX=bull
ENV BULL_VERSION=BULLMQ
ENV USER_LOGIN=''
ENV REDIS_DB=0
ENV PROXY_PATH=''
ENV PORT=3000

EXPOSE $PORT

CMD ["bull-board"]
