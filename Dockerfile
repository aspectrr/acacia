# Dockerfile
FROM oven/bun:1

WORKDIR /app

# Copy package.json and lockfile
COPY package.json ./
COPY bun.lockb ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Expose the proxy port
EXPOSE 3000

# Start the proxy
CMD ["bun", "run", "start"]
