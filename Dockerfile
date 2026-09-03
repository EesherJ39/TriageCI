FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV HOST=0.0.0.0 PORT=8080 TRIAGECI_DATA_DIR=/tmp/triageci
EXPOSE 8080
CMD ["node", "src/server.ts"]
