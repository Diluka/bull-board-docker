FROM denoland/deno:alpine

WORKDIR /usr/app

ENV DENO_ENV=production
ENV REDIS_HOST=localhost
ENV REDIS_PORT=6379
ENV REDIS_USE_TLS=false
ENV REDIS_PASSWORD=""
ENV REDIS_IS_CLUSTER=false
ENV BULL_PREFIX=bull
ENV BULL_VERSION=BULLMQ
ENV USER_LOGIN=""
ENV USER_PASSWORD=""
ENV REDIS_DB=0
ENV PROXY_PATH=""
ENV PORT=3000

# Copy source files
COPY . .

# Cache dependencies
RUN deno cache src/index.ts

EXPOSE $PORT

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "src/index.ts"]
