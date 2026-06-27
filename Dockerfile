FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY README.md ./

ENV HOST=0.0.0.0
ENV PORT=8080
ENV WORKSPACE_DIR=/app/workspace

EXPOSE 8080
VOLUME ["/app/workspace"]

CMD ["node", "src/server.js"]
