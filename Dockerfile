FROM node:18-alpine

WORKDIR /usr/app

ADD ./package.json .
ADD ./package-lock.json .

ENV NODE_ENV production
ENV REDIS_HOST localhost
ENV REDIS_PORT 6379
ENV REDIS_USE_TLS false
ENV REDIS_PASSWORD ''
ENV BULL_PREFIX bull
ENV BULL_VERSION BULLMQ
ENV USER_LOGIN ''
ENV USER_PASSWORD ''
ENV REDIS_DB 0
ENV PROXY_PATH ''
ENV PORT 3000

RUN npm pkg delete scripts.prepare
RUN npm ci --omit=dev

ADD . .

EXPOSE $PORT

CMD ["npm", "start"]
