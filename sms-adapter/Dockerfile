FROM node:22-slim
WORKDIR /app
COPY server.mjs ./
USER node
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
