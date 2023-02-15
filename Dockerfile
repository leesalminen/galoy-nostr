FROM node:16-alpine AS BUILD_IMAGE

WORKDIR /app

RUN apk update && apk add git

COPY ./package.json ./package-lock.json ./

RUN npm install

COPY ./src ./src

USER 1000

ARG BUILDTIME
ARG COMMITHASH
ENV BUILDTIME ${BUILDTIME}
ENV COMMITHASH ${COMMITHASH}

CMD ["node", "src/index.js"]