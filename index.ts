import { Hono } from "hono";
import OpenAI from "openai";
import {
  workspaceManager,
  ComponentSpec,
  FunctionSpec,
} from "./services/workspaceManager";
import { initializeDatabase, extensionService } from "./db/client";

const app = new Hono();

// OpenRouter client configuration
const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
    "X-Title":
      process.env.YOUR_SITE_NAME || "Acacia React/Serverless Agent Platform",
  },
});

// In-memory storage for active agents and chat sessions
const activeAgents = new Map();
const chatSessions = new Map();

// Specialized agent types for React/Serverless development
const AGENT_MODELS = {
  "react-developer": "anthropic/claude-3.5-sonnet",
  "serverless-developer": "anthropic/claude-3.5-sonnet",
  "fullstack-developer": "anthropic/claude-3-opus",
  "database-engineer": "openai/gpt-4-turbo",
};

interface Agent {
  id: string;
  name: string;
  type: keyof typeof AGENT_MODELS;
  status: "active" | "inactive" | "busy";
  model: string;
  systemPrompt: string;
  createdAt: Date;
  lastActivity: Date;
  workspaceReady: boolean;
  currentProject?: {
    componentName?: string;
    functionName?: string;
    requirements?: string;
    props?: Record<string, any>;
  };
}

interface ChatMessage {
  id: string;
  sessionId: string;
  agentId: string;
  userId: string;
  content: string;
  role: "user" | "agent";
  timestamp: Date;
  attachments?: {
    type: "component" | "function" | "migration";
    filename: string;
    content: string;
  }[];
}

// Enhanced system prompts for React/Serverless development
const SYSTEM_PROMPTS = {
  "react-developer": `You are an expert React component developer agent working in a containerized Node.js/TypeScript environment.

Your capabilities:
- Build React components in TypeScript with proper prop interfaces
- Use modern React patterns (hooks, functional components)
- Write clean, accessible, and performant components
- Handle component styling and interactivity
- Work with user-provided prop specifications

Your workspace includes:
- React 18 with TypeScript
- Vite for building and development
- Access to common React patterns and hooks
- File system access to write components in /workspace/components/

When building components:
1. Always create proper TypeScript interfaces for props
2. Use functional components with hooks
3. Add proper error boundaries and loading states when needed
4. Write clean, maintainable code with good comments
5. Ensure components are reusable and testable

You can execute commands in your container and access the file system. Always validate your work by running TypeScript checks and builds.`,

  "serverless-developer": `You are an expert serverless function developer agent working in a Node.js/TypeScript environment.

Your capabilities:
- Build serverless functions in TypeScript
- Design proper input/output interfaces
- Handle async operations and error handling
- Work with databases using Drizzle ORM
- Create RESTful API endpoints

Your workspace includes:
- Node.js 20 with TypeScript
- Bun runtime for fast execution
- Drizzle ORM for database operations
- File system access to write functions in /workspace/functions/

When building functions:
1. Create clear TypeScript interfaces for inputs and outputs
2. Implement proper error handling and validation
3. Use async/await patterns correctly
4. Add appropriate logging and monitoring
5. Ensure functions are stateless and scalable
6. Handle database operations with Drizzle when needed

You can execute commands in your container and access the database. Always validate your work by running TypeScript checks.`,

  "fullstack-developer": `You are an expert fullstack developer agent capable of building complete React components with serverless backends.

Your capabilities:
- Build React components that integrate with serverless functions
- Design data flow between frontend and backend
- Handle state management and API integration
- Create complete feature implementations
- Coordinate database changes with UI updates

Your workspace includes both React and serverless environments with full TypeScript support.

When building fullstack features:
1. Design the data flow from database to UI
2. Create proper API contracts between components and functions
3. Implement error handling across the stack
4. Ensure type safety from database to UI
5. Consider performance and user experience
6. Handle loading states and error boundaries

You coordinate between component and function development, ensuring they work together seamlessly.`,

  "database-engineer": `You are an expert database engineer agent specializing in Drizzle ORM and PostgreSQL.

Your capabilities:
- Design database schemas with Drizzle ORM
- Create and manage migrations
- Optimize database queries and indexes
- Handle data relationships and constraints
- Ensure data integrity and security

Your workspace includes:
- Drizzle ORM and Drizzle Kit
- PostgreSQL database access
- Migration management tools
- Schema design and validation

When working with databases:
1. Design normalized, efficient schemas
2. Create proper indexes for query performance
3. Handle relationships with foreign keys
4. Write safe, reversible migrations
5. Validate data integrity
6. Document schema changes clearly

You can generate migrations, run database commands, and validate schema designs.`,
};

// Helper function to create a new agent
async function createAgent(
  name: string,
  type: keyof typeof AGENT_MODELS,
): Promise<Agent> {
  const id = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const agent: Agent = {
    id,
    name,
    type,
    status: "active",
    model: AGENT_MODELS[type],
    systemPrompt: SYSTEM_PROMPTS[type],
    createdAt: new Date(),
    lastActivity: new Date(),
    workspaceReady: false,
  };

  activeAgents.set(id, agent);

  // Create workspace for the agent
  try {
    await workspaceManager.createWorkspace(id, type);
    agent.workspaceReady = true;
    console.log(`✅ Workspace ready for agent ${name} (${id})`);
  } catch (error) {
    console.error(`Failed to create workspace for agent ${id}:`, error);
  }

  return agent;
}

// Enhanced LLM communication with workspace context
async function sendMessageToLLM(
  agent: Agent,
  message: string,
  conversationHistory: ChatMessage[] = [],
): Promise<{ response: string; attachments?: any[] }> {
  try {
    // Add workspace status to system prompt
    let contextualPrompt = agent.systemPrompt;
    if (agent.workspaceReady) {
      contextualPrompt += `\n\nYour workspace is ready at /workspace with the following structure:
- /workspace/components/ - React components
- /workspace/functions/ - Serverless functions
- /workspace/database/ - Database schemas and migrations
- /workspace/shared/ - Shared types and utilities

You can execute commands using the workspace environment and write files directly.`;
    }

    const messages = [
      { role: "system", content: contextualPrompt },
      ...conversationHistory.slice(-10).map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    const completion = await openrouter.chat.completions.create({
      model: agent.model,
      messages: messages as any,
      temperature: 0.3,
      max_tokens: 3000,
    });

    agent.lastActivity = new Date();
    const response =
      completion.choices[0]?.message?.content ||
      "I apologize, but I couldn't generate a response.";

    // Parse response for any code blocks or file operations
    const attachments = await parseAgentResponse(agent.id, response);

    return { response, attachments };
  } catch (error) {
    console.error(`Error communicating with LLM for agent ${agent.id}:`, error);
    return {
      response:
        "I'm experiencing technical difficulties. Please try again later.",
    };
  }
}

// Parse agent response for code generation and file operations
async function parseAgentResponse(
  agentId: string,
  response: string,
): Promise<any[]> {
  const attachments: any[] = [];

  // Look for code blocks that should be written to files
  const codeBlockRegex = /```(\w+)\s*(?:\/\/\s*(.+))?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(response)) !== null) {
    const [, language, filename, code] = match;

    if (filename && (language === "tsx" || language === "ts")) {
      try {
        await containerManager.writeFile(agentId, filename, code.trim());
        attachments.push({
          type: filename.includes("components/") ? "component" : "function",
          filename,
          content: code.trim(),
        });
      } catch (error) {
        console.error(
          `Failed to write file ${filename} for agent ${agentId}:`,
          error,
        );
      }
    }
  }

  return attachments;
}

// Initialize database and workspace manager
async function initializePlatform() {
  try {
    await initializeDatabase();
    await workspaceManager.initialize();
    console.log("✅ Platform initialized successfully");
  } catch (error) {
    console.error("❌ Platform initialization failed:", error);
    process.exit(1);
  }
}

initializePlatform();

// Root route with enhanced documentation
app.get("/", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Acacia React/Serverless Agent Platform</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1000px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
          }
          .endpoint {
            background: #f8f9fa;
            padding: 20px;
            margin: 15px 0;
            border-radius: 8px;
            border-left: 4px solid #007acc;
          }
          .agent-type {
            background: #e3f2fd;
            padding: 15px;
            margin: 10px 0;
            border-radius: 8px;
            border-left: 4px solid #1976d2;
          }
          code {
            background: #f4f4f4;
            padding: 3px 8px;
            border-radius: 4px;
            font-family: 'SF Mono', Monaco, monospace;
          }
          .header { color: #1976d2; }
          .description { color: #666; margin-top: 5px; }
        </style>
      </head>
      <body>
        <h1 class="header">🌳 Acacia React/Serverless Agent Platform</h1>
        <p>AI-powered development agents specialized in React components, serverless functions, and database management with containerized development environments.</p>

        <h2 class="header">🤖 Agent Types & Capabilities:</h2>

        <div class="agent-type">
          <strong>react-developer</strong> (Claude 3.5 Sonnet)
          <div class="description">Builds React components with TypeScript, proper props, and modern patterns</div>
        </div>

        <div class="agent-type">
          <strong>serverless-developer</strong> (Claude 3.5 Sonnet)
          <div class="description">Creates serverless functions with Node.js/TypeScript and database integration</div>
        </div>

        <div class="agent-type">
          <strong>fullstack-developer</strong> (Claude 3 Opus)
          <div class="description">Builds complete features with React frontend and serverless backend</div>
        </div>

        <div class="agent-type">
          <strong>database-engineer</strong> (GPT-4 Turbo)
          <div class="description">Designs schemas and manages database migrations with Drizzle ORM</div>
        </div>

        <h2 class="header">🔌 API Endpoints:</h2>

        <div class="endpoint">
          <strong>GET /agents</strong>
          <div class="description">List all active agents and their workspace status</div>
        </div>

        <div class="endpoint">
          <strong>POST /agents</strong>
          <div class="description">Create a new specialized development agent</div>
        </div>

        <div class="endpoint">
          <strong>POST /agents/:id/chat</strong>
          <div class="description">Send development instructions to an agent</div>
        </div>

        <div class="endpoint">
          <strong>POST /agents/:id/component</strong>
          <div class="description">Request a React component with specific props and requirements</div>
        </div>

        <div class="endpoint">
          <strong>POST /agents/:id/function</strong>
          <div class="description">Request a serverless function with input/output specifications</div>
        </div>

        <div class="endpoint">
          <strong>GET /agents/:id/workspace</strong>
          <div class="description">View agent workspace status and files</div>
        </div>

        <div class="endpoint">
          <strong>POST /agents/:id/build</strong>
          <div class="description">Build and validate agent's current work</div>
        </div>

        <h2 class="header">🚀 Quick Start:</h2>
        <pre><code># Create a React component agent
curl -X POST http://localhost:3000/agents \\
  -H "Content-Type: application/json" \\
  -d '{"name": "ComponentBot", "type": "react-developer"}'

# Request a component
curl -X POST http://localhost:3000/agents/{agent-id}/component \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "UserCard",
    "props": {"name": "string", "email": "string", "avatar": "string"},
    "requirements": "Create a user profile card with avatar, name, and email"
  }'</code></pre>
      </body>
    </html>
  `);
});

// Get all agents with workspace status
app.get("/agents", async (c) => {
  const agents = Array.from(activeAgents.values());
  const workspaces = await workspaceManager.listWorkspaces();

  const agentsWithWorkspace = agents.map((agent) => ({
    ...agent,
    workspace: workspaces.find((w) => w.agentId === agent.id),
  }));

  return c.json({
    message: "Active development agents",
    count: agents.length,
    agents: agentsWithWorkspace,
  });
});

// Create a new specialized agent
app.post("/agents", async (c) => {
  const body = await c.req.json();
  const { name, type } = body;

  if (!name || !type) {
    return c.json({ error: "Name and type are required" }, 400);
  }

  if (!AGENT_MODELS[type as keyof typeof AGENT_MODELS]) {
    return c.json(
      {
        error: "Invalid agent type",
        validTypes: Object.keys(AGENT_MODELS),
      },
      400,
    );
  }

  const agent = await createAgent(name, type);

  return c.json(
    {
      message: "Development agent created successfully",
      agent: agent,
    },
    201,
  );
});

// Chat with a specialized agent
app.post("/agents/:id/chat", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const { message, userId } = body;

  if (!message || !userId) {
    return c.json({ error: "Message and userId are required" }, 400);
  }

  const agent = activeAgents.get(agentId);
  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  if (!agent.workspaceReady) {
    return c.json({ error: "Agent workspace is not ready" }, 503);
  }

  const sessionId = `${agentId}-${userId}`;
  const history = chatSessions.get(sessionId) || [];

  agent.status = "busy";

  try {
    const { response, attachments } = await sendMessageToLLM(
      agent,
      message,
      history,
    );

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}-1`,
      sessionId,
      agentId,
      userId,
      content: message,
      role: "user",
      timestamp: new Date(),
    };

    const agentMessage: ChatMessage = {
      id: `msg-${Date.now()}-2`,
      sessionId,
      agentId,
      userId,
      content: response,
      role: "agent",
      timestamp: new Date(),
      attachments,
    };

    const updatedHistory = [...history, userMessage, agentMessage].slice(-20);
    chatSessions.set(sessionId, updatedHistory);

    agent.status = "active";

    return c.json({
      userMessage,
      agentMessage,
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
      },
    });
  } catch (error) {
    agent.status = "active";
    console.error("Chat error:", error);
    return c.json({ error: "Failed to process chat message" }, 500);
  }
});

// Request a React component
app.post("/agents/:id/component", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const { name, props, requirements } = body;

  const agent = activeAgents.get(agentId);
  if (!agent || !agent.workspaceReady) {
    return c.json({ error: "Agent not found or workspace not ready" }, 404);
  }

  if (!["react-developer", "fullstack-developer"].includes(agent.type)) {
    return c.json(
      { error: "Agent is not configured for React development" },
      400,
    );
  }

  try {
    const spec: ComponentSpec = { name, props, requirements };
    const { component, types } = await workspaceManager.createComponent(
      agentId,
      spec,
    );

    // Update agent's current project
    agent.currentProject = { componentName: name, requirements, props };

    return c.json({
      message: `React component ${name} created successfully`,
      component: {
        name,
        code: component,
        types,
        props,
      },
      workspace: await workspaceManager.getWorkspaceStatus(agentId),
    });
  } catch (error) {
    console.error("Component creation error:", error);
    return c.json({ error: "Failed to create component" }, 500);
  }
});

// Request a serverless function
app.post("/agents/:id/function", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const { name, input, output, requirements } = body;

  const agent = activeAgents.get(agentId);
  if (!agent || !agent.workspaceReady) {
    return c.json({ error: "Agent not found or workspace not ready" }, 404);
  }

  if (!["serverless-developer", "fullstack-developer"].includes(agent.type)) {
    return c.json(
      { error: "Agent is not configured for serverless development" },
      400,
    );
  }

  try {
    const spec: FunctionSpec = { name, input, output, requirements };
    const functionCode = await workspaceManager.createFunction(agentId, spec);

    agent.currentProject = { functionName: name, requirements };

    return c.json({
      message: `Serverless function ${name} created successfully`,
      function: {
        name,
        code: functionCode,
        input,
        output,
      },
      workspace: await workspaceManager.getWorkspaceStatus(agentId),
    });
  } catch (error) {
    console.error("Function creation error:", error);
    return c.json({ error: "Failed to create function" }, 500);
  }
});

// Get workspace status and files
app.get("/agents/:id/workspace", async (c) => {
  const agentId = c.req.param("id");
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const workspace = await workspaceManager.getWorkspaceStatus(agentId);

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      currentProject: agent.currentProject,
    },
    workspace,
  });
});

// Build and validate agent's work
app.post("/agents/:id/build", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const { type } = body; // 'component', 'function', or 'all'

  const agent = activeAgents.get(agentId);
  if (!agent || !agent.workspaceReady) {
    return c.json({ error: "Agent not found or workspace not ready" }, 404);
  }

  try {
    const results: any = {};

    if (type === "component" || type === "all") {
      results.component = await workspaceManager.buildComponent(agentId);
    }

    if (type === "function" || type === "all") {
      results.function = await workspaceManager.buildFunction(agentId);
    }

    // Always run type checking
    results.typecheck = await workspaceManager.runTypeCheck(agentId);

    return c.json({
      message: "Build completed",
      results,
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
      },
    });
  } catch (error) {
    console.error("Build error:", error);
    return c.json(
      {
        error: "Build failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Execute custom commands in agent workspace
app.post("/agents/:id/execute", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const { command } = body;

  const agent = activeAgents.get(agentId);
  if (!agent || !agent.workspaceReady) {
    return c.json({ error: "Agent not found or workspace not ready" }, 404);
  }

  try {
    const output = await workspaceManager.executeCommand(agentId, command);

    return c.json({
      command,
      output,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Command execution error:", error);
    return c.json(
      {
        error: "Command execution failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

const port = parseInt(process.env.PORT || "8080");

console.log(
  `🚀 Acacia React/Serverless Agent Platform running on http://localhost:${port}`,
);
console.log(`🤖 Specialized agents: ${Object.keys(AGENT_MODELS).join(", ")}`);
console.log(`🐳 Docker-based development environments ready`);

// Create some default agents on startup after platform initialization
setTimeout(async () => {
  try {
    await Promise.all([
      createAgent("ReactBot", "react-developer"),
      createAgent("ServerlessBot", "serverless-developer"),
      createAgent("FullStackBot", "fullstack-developer"),
    ]);
    console.log(`✅ Default agents created with workspaces`);
  } catch (error) {
    console.error("Failed to create default agents:", error);
  }
}, 2000); // Wait 2 seconds for platform to fully initialize

export default {
  port: port,
  fetch: app.fetch,
  websocket: {
    message(ws: any, message: string) {
      try {
        const data = JSON.parse(message);
        const { type, payload } = data;

        switch (type) {
          case "join_workspace":
            ws.data = { userId: payload.userId, agentId: payload.agentId };
            ws.send(
              JSON.stringify({
                type: "joined",
                payload: {
                  message: `Connected to ${payload.agentId} workspace`,
                },
              }),
            );
            break;

          case "development_chat":
            const { agentId, userId, message: devMessage } = payload;
            const agent = activeAgents.get(agentId);

            if (agent && agent.workspaceReady) {
              sendMessageToLLM(agent, devMessage)
                .then(({ response, attachments }) => {
                  ws.send(
                    JSON.stringify({
                      type: "agent_response",
                      payload: {
                        agentId,
                        message: response,
                        attachments,
                        timestamp: new Date().toISOString(),
                      },
                    }),
                  );
                })
                .catch((error) => {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      payload: { message: "Failed to get agent response" },
                    }),
                  );
                });
            }
            break;

          default:
            ws.send(
              JSON.stringify({
                type: "error",
                payload: { message: "Unknown message type" },
              }),
            );
        }
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            payload: { message: "Invalid message format" },
          }),
        );
      }
    },

    open(ws: any) {
      console.log("WebSocket connection opened for development workspace");
    },

    close(ws: any) {
      console.log("WebSocket connection closed");
    },
  },
};
