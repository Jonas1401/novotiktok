# Any host that can run a long-lived container works (Fly.io, Railway, Render,
# a VPS, ...). This app needs a persistent process: it keeps the match in memory
# and pushes updates over a Socket.IO connection.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The daily leaderboard is written here at runtime.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
