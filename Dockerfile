FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
EXPOSE 8080
RUN chown -R node /usr/src/app
USER node
CMD ["node", "build/src/server.js"]
