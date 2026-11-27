FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
# better-sqlite3 se compile : outils nécessaires pendant l'installation seulement, retirés ensuite.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
