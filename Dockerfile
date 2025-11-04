# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package.json and lockfile
COPY package*.json ./

# Install dependencies
RUN npm ci || npm install

# Copy source code
COPY . .

# Expose the proxy port
EXPOSE 8080

# Start the proxy
CMD ["npm", "run", "start"]
