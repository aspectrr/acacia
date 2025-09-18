# 🌳 Acacia Integration Guide

**Add AI development agents to any existing product with a single container**

Acacia runs as a lightweight sidecar container that attaches to your existing project, giving you AI-powered React components and serverless functions without disrupting your current setup.

## 🚀 Quick Start (5 minutes)

### 1. Add Acacia to Your Project

```bash
# In your existing project directory
curl -o docker-compose.acacia.yml https://raw.githubusercontent.com/your-org/acacia/main/docker-compose.sidecar.yml

# Or copy the docker-compose.sidecar.yml file to your project
```

### 2. Configure Environment

Create `.env.acacia` in your project root:

```env
# Required: OpenRouter API key for LLM access
OPENROUTER_API_KEY=your_key_here

# Your project path (usually just .)
HOST_PROJECT_PATH=.

# Your main app URL (for integration)
MAIN_APP_URL=http://localhost:3000

# Optional: Database for persistent agent state
POSTGRES_PASSWORD=secure_password
```

### 3. Start Acacia

```bash
# Start Acacia alongside your existing app
docker-compose -f docker-compose.acacia.yml up -d

# Acacia will be available at http://localhost:3100
# Your main app continues running on its original port
```

## 🎯 How It Works

### Single Container Architecture
- **One container** manages all AI agents (no exponential scaling)
- **File system mounting** for direct project integration
- **Workspace isolation** keeps agent work organized
- **Zero impact** on your existing application

### Integration Points
```
Your Project/
├── src/
│   ├── components/     # Acacia can read/write here
│   ├── functions/      # Acacia can create serverless functions
│   └── ...
├── package.json        # Acacia detects your stack
├── .env.acacia         # Acacia configuration
└── docker-compose.acacia.yml  # Acacia container
```

## 🛠 Usage Examples

### Create a React Component
```bash
curl -X POST http://localhost:3100/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "UIBot", "type": "react-developer"}'

curl -X POST http://localhost:3100/agents/{agent-id}/component \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ProductCard",
    "props": {
      "title": "string",
      "price": "number",
      "onAddToCart": "function"
    },
    "requirements": "Modern product card with image, title, price, and CTA button"
  }'
```

### Create a Serverless Function
```bash
curl -X POST http://localhost:3100/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "APIBot", "type": "serverless-developer"}'

curl -X POST http://localhost:3100/agents/{agent-id}/function \
  -H "Content-Type: application/json" \
  -d '{
    "name": "getUserProfile",
    "input": {"userId": "string"},
    "output": {"user": "User", "preferences": "UserPreferences"},
    "requirements": "Fetch user profile with preferences from database"
  }'
```

### Chat-Based Development
```bash
curl -X POST http://localhost:3100/agents/{agent-id}/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a user dashboard component with charts and recent activity",
    "userId": "developer123"
  }'
```

## 🔌 Framework Integration

### Next.js Projects
```yaml
# docker-compose.acacia.yml
services:
  acacia:
    # ... standard config
    volumes:
      - .:/workspace/host-project
      - ./src/components:/workspace/output/components
      - ./src/api:/workspace/output/functions
```

### React + Express
```yaml
volumes:
  - ./client/src/components:/workspace/output/components
  - ./server/functions:/workspace/output/functions
```

### Any TypeScript Project
Acacia auto-detects your:
- `package.json` dependencies
- Existing component structure
- TypeScript configuration
- Build tools (Vite, Webpack, etc.)

## 🏗 Agent Types

| Type | Purpose | Model | Output |
|------|---------|-------|---------|
| `react-developer` | UI Components | Claude 3.5 Sonnet | `.tsx` files |
| `serverless-developer` | API Functions | Claude 3.5 Sonnet | `.ts` functions |
| `fullstack-developer` | Complete Features | Claude 3 Opus | Components + Functions |
| `database-engineer` | Schema Design | GPT-4 Turbo | Migrations |

## 📂 File Organization

Acacia creates organized workspaces:

```
workspaces/
├── agent-123/
│   ├── components/
│   │   ├── ProductCard.tsx
│   │   └── index.tsx
│   ├── functions/
│   │   ├── getUserProfile.ts
│   │   └── index.ts
│   ├── shared/
│   │   └── types.ts
│   └── output/        # Built artifacts
└── agent-456/
    └── ...
```

## 🔒 Security & Limits

### Container Security
- Non-root user execution
- Memory limits (512MB per container)
- CPU limits (0.5 cores)
- Network isolation options

### Resource Management
- **Single container** scales agents internally
- Workspace cleanup after inactivity
- Command execution timeouts
- File system sandboxing

## 🚫 What This ISN'T

❌ **Not a full IDE replacement**  
✅ **Focused on component/function generation**

❌ **Not a deployment platform**  
✅ **Generates code for your existing deployment**

❌ **Not a container orchestration system**  
✅ **Single sidecar container that just works**

## 🔧 Advanced Configuration

### Custom Agent Types
```javascript
// In your .env.acacia
CUSTOM_AGENTS='{"ui-specialist": "anthropic/claude-3.5-sonnet"}'
```

### Workspace Persistence
```yaml
volumes:
  - acacia-workspaces:/workspace/agents  # Persistent agent work
```

### Integration with CI/CD
```yaml
# Optional: Auto-deploy agent-generated code
- name: Deploy Acacia Components
  run: docker-compose -f docker-compose.acacia.yml exec acacia bun run deploy
```

## 📈 Scaling Strategy

### Single Product
- One Acacia container
- Multiple agents (managed internally)
- Shared workspace volume

### Multiple Products
- One Acacia per product
- Different ports (3100, 3101, 3102...)
- Separate environment files

### Enterprise
- Centralized Acacia with multi-tenancy
- Agent pools per team/product
- Shared knowledge base

## 🆘 Troubleshooting

### "Agent workspace not ready"
```bash
# Check container health
docker-compose -f docker-compose.acacia.yml ps

# View logs
docker-compose -f docker-compose.acacia.yml logs acacia
```

### "Permission denied" errors
```bash
# Fix file permissions
sudo chown -R $USER:$USER ./workspaces
```

### "Cannot connect to OpenRouter"
```bash
# Verify API key
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/models
```

## 🎉 Next Steps

1. **Start with one agent** - Try the React developer
2. **Generate a simple component** - Test the workflow
3. **Integrate with your build process** - Copy generated files
4. **Scale up** - Add more specialized agents
5. **Customize** - Adjust for your specific tech stack

---

**Questions?** Check the [GitHub Issues](https://github.com/your-org/acacia/issues) or join our [Discord](https://discord.gg/acacia)