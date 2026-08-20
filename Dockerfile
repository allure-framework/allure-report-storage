FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY scripts ./scripts
COPY tsconfig.json ./
COPY src ./src
COPY README.md ./README.md

RUN corepack enable \
    && yarn config set supportedArchitectures.os --json '["current"]' \
    && yarn config set supportedArchitectures.cpu --json '["current"]' \
    && yarn config set supportedArchitectures.libc --json '["current"]' \
    && yarn install --immutable
RUN yarn build

ENV PORT=3000
ENV DATA_DIR=/data
ENV DATABASE_PATH=/data/reports.sqlite

VOLUME ["/data"]
EXPOSE 3000

CMD ["yarn", "start"]
