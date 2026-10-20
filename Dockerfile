FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
