import { promises as fs } from "fs";
import path from "path";
import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface AgentWorkspace {
  agentId: string;
  workspacePath: string;
  status: "ready" | "busy" | "error";
  createdAt: Date;
  lastActivity: Date;
  projectType: "react" | "serverless" | "fullstack" | "database";
}

export interface ComponentSpec {
  name: string;
  props: Record<string, any>;
  requirements: string;
}

export interface FunctionSpec {
  name: string;
  input: Record<string, any>;
  output: Record<string, any>;
  requirements: string;
}

export interface ProjectContext {
  hostProjectPath?: string;
  packageJsonPath?: string;
  existingComponents?: string[];
  existingFunctions?: string[];
}

export class WorkspaceManager {
  private workspaces = new Map<string, AgentWorkspace>();
  private readonly baseWorkspacePath: string;
  private readonly hostProjectPath: string;
  private projectContext: ProjectContext = {};

  constructor(
    baseWorkspacePath = "./workspaces",
    hostProjectPath = process.env.HOST_PROJECT_PATH || "./host-project",
  ) {
    this.baseWorkspacePath = path.resolve(baseWorkspacePath);
    this.hostProjectPath = path.resolve(hostProjectPath);
  }

  async initialize(): Promise<void> {
    // Ensure base workspace directory exists
    await fs.mkdir(this.baseWorkspacePath, { recursive: true });

    // Detect host project structure
    await this.detectProjectContext();

    console.log("🚀 Workspace Manager initialized");
    console.log(`📁 Workspaces: ${this.baseWorkspacePath}`);
    console.log(`🏠 Host Project: ${this.hostProjectPath}`);
  }

  private async detectProjectContext(): Promise<void> {
    try {
      // Check if host project exists and has package.json
      const packageJsonPath = path.join(this.hostProjectPath, "package.json");

      if (await this.fileExists(packageJsonPath)) {
        const packageJson = JSON.parse(
          await fs.readFile(packageJsonPath, "utf8"),
        );
        this.projectContext = {
          hostProjectPath: this.hostProjectPath,
          packageJsonPath,
          existingComponents: await this.findExistingComponents(),
          existingFunctions: await this.findExistingFunctions(),
        };

        console.log("✅ Detected existing project with package.json");
      } else {
        console.log("📝 No existing project detected, will work in isolation");
      }
    } catch (error) {
      console.log("⚠️ Could not detect project context, working in isolation");
    }
  }

  private async findExistingComponents(): Promise<string[]> {
    try {
      const possibleDirs = ["src/components", "components", "src"];
      const components: string[] = [];

      for (const dir of possibleDirs) {
        const fullPath = path.join(this.hostProjectPath, dir);
        if (await this.directoryExists(fullPath)) {
          const files = await fs.readdir(fullPath);
          const componentFiles = files.filter(
            (f) => f.endsWith(".tsx") || f.endsWith(".jsx"),
          );
          components.push(...componentFiles);
        }
      }

      return components;
    } catch {
      return [];
    }
  }

  private async findExistingFunctions(): Promise<string[]> {
    try {
      const possibleDirs = ["src/functions", "functions", "api", "src/api"];
      const functions: string[] = [];

      for (const dir of possibleDirs) {
        const fullPath = path.join(this.hostProjectPath, dir);
        if (await this.directoryExists(fullPath)) {
          const files = await fs.readdir(fullPath);
          const functionFiles = files.filter(
            (f) => f.endsWith(".ts") || f.endsWith(".js"),
          );
          functions.push(...functionFiles);
        }
      }

      return functions;
    } catch {
      return [];
    }
  }

  async createWorkspace(
    agentId: string,
    projectType: AgentWorkspace["projectType"],
  ): Promise<AgentWorkspace> {
    const workspacePath = path.join(this.baseWorkspacePath, agentId);

    // Create workspace directory structure
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(path.join(workspacePath, "components"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "functions"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "database"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "shared"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "output"), { recursive: true });

    // Create workspace-specific package.json
    const packageJson = {
      name: `agent-workspace-${agentId}`,
      version: "1.0.0",
      type: "module",
      scripts: {
        "dev:component": "vite --config vite.config.ts --port 5174",
        "build:component": "vite build --config vite.config.ts",
        "dev:function": "tsx watch functions/index.ts",
        "build:function":
          "esbuild functions/index.ts --bundle --platform=node --format=esm --outdir output/function",
        typecheck: "tsc --noEmit",
        lint: "eslint . --ext ts,tsx --max-warnings 0",
        format: "prettier --write .",
      },
      dependencies: {
        react: "^18.2.0",
        "react-dom": "^18.2.0",
      },
      devDependencies: {
        "@types/react": "^18.2.0",
        "@types/react-dom": "^18.2.0",
        typescript: "^5.0.0",
        vite: "^5.0.0",
        "@vitejs/plugin-react": "^4.0.0",
        eslint: "^8.0.0",
        prettier: "^3.0.0",
      },
    };

    await this.writeFile(
      agentId,
      "package.json",
      JSON.stringify(packageJson, null, 2),
    );

    // Create TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        baseUrl: ".",
        paths: {
          "@/*": ["./shared/*"],
          "@components/*": ["./components/*"],
          "@functions/*": ["./functions/*"],
          "@host/*": ["../host-project/*"],
        },
      },
      include: [
        "components/**/*",
        "functions/**/*",
        "shared/**/*",
        "database/**/*",
      ],
    };

    await this.writeFile(
      agentId,
      "tsconfig.json",
      JSON.stringify(tsConfig, null, 2),
    );

    // Create Vite config for React development
    const viteConfig = `import { defineConfig } from 'vite'
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
})`;

    await this.writeFile(agentId, "vite.config.ts", viteConfig);

    // Create initial template files
    await this.createInitialTemplates(agentId, projectType);

    // Install dependencies
    try {
      await this.executeCommand(agentId, "npm install");
    } catch (error) {
      console.warn(`Could not install dependencies for ${agentId}:`, error);
    }

    const workspace: AgentWorkspace = {
      agentId,
      workspacePath,
      status: "ready",
      createdAt: new Date(),
      lastActivity: new Date(),
      projectType,
    };

    this.workspaces.set(agentId, workspace);
    console.log(`✅ Created workspace for agent ${agentId} (${projectType})`);

    return workspace;
  }

  private async createInitialTemplates(
    agentId: string,
    projectType: AgentWorkspace["projectType"],
  ): Promise<void> {
    // Component template
    const componentTemplate = `import React from 'react';

export interface ComponentProps {
  // Props will be defined by the agent based on requirements
}

const Component: React.FC<ComponentProps> = (props) => {
  return (
    <div>
      {/* Component implementation will be generated by agent */}
      <h1>Agent-Generated Component</h1>
    </div>
  );
};

export default Component;`;

    await this.writeFile(agentId, "components/index.tsx", componentTemplate);

    // Function template
    const functionTemplate = `export interface FunctionInput {
  // Input type will be defined by agent
}

export interface FunctionOutput {
  success: boolean;
  message: string;
}

export default async function handler(input: FunctionInput): Promise<FunctionOutput> {
  // Function implementation will be generated by agent
  return {
    success: true,
    message: "Agent-generated function executed successfully"
  };
}`;

    await this.writeFile(agentId, "functions/index.ts", functionTemplate);

    // Shared types
    const typesTemplate = `export interface BaseProps {
  className?: string;
  children?: React.ReactNode;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}`;

    await this.writeFile(agentId, "shared/types.ts", typesTemplate);
  }

  async executeCommand(agentId: string, command: string): Promise<string> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    workspace.status = "busy";
    workspace.lastActivity = new Date();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workspace.workspacePath,
        timeout: 30000, // 30 second timeout
      });

      workspace.status = "ready";
      return stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
    } catch (error) {
      workspace.status = "ready";
      throw error;
    }
  }

  async writeFile(
    agentId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    const fullPath = path.join(workspace.workspacePath, filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, content, "utf8");

    workspace.lastActivity = new Date();
  }

  async readFile(agentId: string, filePath: string): Promise<string> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    const fullPath = path.join(workspace.workspacePath, filePath);
    return await fs.readFile(fullPath, "utf8");
  }

  async createComponent(
    agentId: string,
    spec: ComponentSpec,
  ): Promise<{ component: string; types: string }> {
    // Generate TypeScript interface for props
    const propsInterface = this.generatePropsInterface(spec.name, spec.props);

    // Write props interface to shared types
    const existingTypes = await this.readFile(agentId, "shared/types.ts").catch(
      () => "",
    );
    const updatedTypes = existingTypes + "\n\n" + propsInterface;
    await this.writeFile(agentId, "shared/types.ts", updatedTypes);

    // Generate component structure
    const componentCode = `import React from 'react';
import { ${spec.name}Props } from '../shared/types';

const ${spec.name}: React.FC<${spec.name}Props> = (props) => {
  return (
    <div>
      {/* Implementation will be generated by agent based on requirements */}
      {/* ${spec.requirements} */}
    </div>
  );
};

export default ${spec.name};`;

    // Write component file
    await this.writeFile(agentId, `components/${spec.name}.tsx`, componentCode);

    // Update components index
    const indexContent = `export { default as ${spec.name} } from './${spec.name}';`;
    await this.writeFile(agentId, "components/index.tsx", indexContent);

    return {
      component: componentCode,
      types: propsInterface,
    };
  }

  async createFunction(agentId: string, spec: FunctionSpec): Promise<string> {
    const functionCode = `export interface ${spec.name}Input {
${Object.entries(spec.input)
  .map(([key, value]) => `  ${key}: ${this.inferTypeScriptType(value)};`)
  .join("\n")}
}

export interface ${spec.name}Output {
${Object.entries(spec.output)
  .map(([key, value]) => `  ${key}: ${this.inferTypeScriptType(value)};`)
  .join("\n")}
}

export default async function ${spec.name}(input: ${spec.name}Input): Promise<${spec.name}Output> {
  // Function implementation based on: ${spec.requirements}

  try {
    // Implementation will be generated by agent
    throw new Error('Function not yet implemented');
  } catch (error) {
    throw new Error(\`${spec.name} failed: \${error instanceof Error ? error.message : 'Unknown error'}\`);
  }
}`;

    // Write function file
    await this.writeFile(agentId, `functions/${spec.name}.ts`, functionCode);

    // Update functions index
    const indexContent = `export { default as ${spec.name} } from './${spec.name}';`;
    await this.writeFile(agentId, "functions/index.ts", indexContent);

    return functionCode;
  }

  async buildComponent(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, "npm run build:component");
  }

  async buildFunction(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, "npm run build:function");
  }

  async runTypeCheck(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, "npm run typecheck");
  }

  async runLinter(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, "npm run lint");
  }

  private generatePropsInterface(
    componentName: string,
    props: Record<string, any>,
  ): string {
    const propTypes = Object.entries(props)
      .map(([key, value]) => {
        const type = this.inferTypeScriptType(value);
        return `  ${key}: ${type};`;
      })
      .join("\n");

    return `export interface ${componentName}Props {
${propTypes}
}`;
  }

  private inferTypeScriptType(value: any): string {
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) return "any[]";
    if (typeof value === "object") return "Record<string, any>";
    if (typeof value === "function") return "() => void";
    return "any";
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async getWorkspaceStatus(agentId: string): Promise<AgentWorkspace | null> {
    return this.workspaces.get(agentId) || null;
  }

  async listWorkspaces(): Promise<AgentWorkspace[]> {
    return Array.from(this.workspaces.values());
  }

  async removeWorkspace(agentId: string): Promise<void> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) return;

    try {
      // Clean up workspace files
      await fs.rm(workspace.workspacePath, { recursive: true, force: true });
      this.workspaces.delete(agentId);

      console.log(`🗑️ Removed workspace for agent ${agentId}`);
    } catch (error) {
      console.error(`Failed to remove workspace for agent ${agentId}:`, error);
      throw error;
    }
  }

  getProjectContext(): ProjectContext {
    return this.projectContext;
  }

  async copyToHostProject(
    agentId: string,
    sourceFile: string,
    destinationPath: string,
  ): Promise<void> {
    if (!this.projectContext.hostProjectPath) {
      throw new Error("No host project detected");
    }

    const sourcePath = path.join(this.baseWorkspacePath, agentId, sourceFile);
    const destPath = path.join(
      this.projectContext.hostProjectPath,
      destinationPath,
    );

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    // Copy file
    await fs.copyFile(sourcePath, destPath);

    console.log(`📋 Copied ${sourceFile} to host project: ${destinationPath}`);
  }
}

export const workspaceManager = new WorkspaceManager();
