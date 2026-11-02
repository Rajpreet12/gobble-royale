FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "src/index.mjs"]
