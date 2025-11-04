FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    python3 \
    make \
    g++ \
    postgresql-client

# Install Bun for fast package management
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Set working directory
WORKDIR /app

# Copy application files
COPY package.json bun.lock* ./
COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

# Create workspace directories
RUN mkdir -p /workspace/host-project \
    /workspace/agents \
    /workspace/shared \
    /workspace/temp

# Install global development tools for agent work
RUN bun add -g \
    typescript \
    @types/node \
    drizzle-kit \
    vite \
    @vitejs/plugin-react \
    eslint \
    prettier

# Create shared package.json template for agent workspaces
COPY <<EOF /workspace/shared/package.template.json
{
"name": "agent-workspace",
"version": "1.0.0",
"type": "module",
"scripts": {
"dev:component": "vite --config vite.component.config.ts --port 5174",
"build:component": "vite build --config vite.component.config.ts",
"dev:function": "bun run --hot functions/index.ts",
"build:function": "bun build functions/index.ts --outdir output/function",
"typecheck": "tsc --noEmit",
"lint": "eslint . --ext ts,tsx --max-warnings 0",
"format": "prettier --write ."
}
EOF

# Create shared TypeScript config template
COPY <<EOF /workspace/shared/tsconfig.template.json
{
"compilerOptions": {
"target": "ES2022",
"lib": ["ES2023", "DOM", "DOM.Iterable"],
"module": "ESNext",
"skipLibCheck": true,
"moduleResolution": "bundler",
"allowImportingTsExtensions": true,
"resolveJsonModule": true,
"isolatedModules": true,
"noEmit": true,
"jsx": "react-jsx",
"strict": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"noFallthroughCasesInSwitch": true,
"baseUrl": ".",
"paths": {
"@/*": ["./shared/*"],
"@components/*": ["./components/*"],
"@functions/*": ["./functions/*"]
}
},
"include": [
"components/**/*",
"functions/**/*",
"shared/**/*",
"database/**/*",
"../host-project/**/*"
]
}
EOF

# Create Vite config template for components
COPY <<EOF /workspace/shared/vite.config.template.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
plugins: [react()],
root: './components',
build: {
outDir: '../output/component',
lib: {
entry: resolve(__dirname, 'components/index.tsx'),
name: 'Component',
fileName: 'component',
formats: ['es', 'cjs']
},
rollupOptions: {
external: ['react', 'react-dom'],
output: {
globals: {
react: 'React',
'react-dom': 'ReactDOM'
}
}
}
},
resolve: {
alias: {
'@': resolve(__dirname, './shared'),
'@components': resolve(__dirname, './components'),
'@functions': resolve(__dirname, './functions'),
'@host': resolve(__dirname, '../host-project')
}
}
})
EOF

# Create initialization script
COPY <<EOF /workspace/init-agent.sh
#!/bin/bash
set -e

AGENT_ID=$1
if [ -z "$AGENT_ID" ]; then
echo "Usage: $0 <agent-id>"
exit 1
fi

AGENT_DIR="/workspace/agents/$AGENT_ID"

# Create agent directory structure
mkdir -p "$AGENT_DIR"/{components,functions,database,shared,output}

# Copy templates
cp /workspace/shared/package.template.json "$AGENT_DIR/package.json"
cp /workspace/shared/tsconfig.template.json "$AGENT_DIR/tsconfig.json"
cp /workspace/shared/vite.config.template.ts "$AGENT_DIR/vite.component.config.ts"

# Create basic files
cat > "$AGENT_DIR/components/index.tsx" << 'EOC'
import React from 'react';

export interface ComponentProps {
// Props will be defined by the agent
}

const Component: React.FC<ComponentProps> = (props) => {
return <div>Agent-generated component</div>;
};

export default Component;
EOC

cat > "$AGENT_DIR/functions/index.ts" << 'EOF2'
export interface FunctionInput {
// Input type will be defined by agent
}

export interface FunctionOutput {
success: boolean;
message: string;
}

export default async function handler(input: FunctionInput): Promise<FunctionOutput> {
return { success: true, message: "Agent-generated function" };
}
EOF2

cat > "$AGENT_DIR/shared/types.ts" << 'EOF3'
export interface BaseProps {
className?: string;
children?: React.ReactNode;
}

export interface ApiResponse<T = unknown> {
success: boolean;
data?: T;
error?: string;
}
EOF3

# Install dependencies for this agent workspace
cd "$AGENT_DIR"
bun install react@^18.2.0 react-dom@^18.2.0 @types/react@^18.2.0 @types/react-dom@^18.2.0

echo "✅ Agent workspace $AGENT_ID initialized"
EOF

RUN chmod +x /workspace/init-agent.sh

# Create a non-root user for security
RUN addgroup -g 1001 -S acacia && \
    adduser -S acacia -u 1001 -G acacia

# Change ownership
RUN chown -R acacia:acacia /app /workspace

# Switch to non-root user
USER acacia

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["bun", "run", "index.ts"]
