FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY public ./public
ENV PORT=8080 DB_PATH=/data/tracker.db
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
