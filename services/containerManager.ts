import Docker from 'dockerode';
import { promises as fs } from 'fs';
import path from 'path';

const docker = new Docker();

export interface AgentWorkspace {
  agentId: string;
  containerId?: string;
  containerName: string;
  workspacePath: string;
  status: 'creating' | 'ready' | 'busy' | 'stopped' | 'error';
  createdAt: Date;
  lastActivity: Date;
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

export interface DatabaseChange {
  type: 'create_table' | 'alter_table' | 'add_column' | 'create_index';
  description: string;
  schema: string;
}

export class ContainerManager {
  private workspaces = new Map<string, AgentWorkspace>();
  private readonly baseWorkspacePath: string;
  private readonly imageName = 'agent-workspace:latest';

  constructor(baseWorkspacePath = './workspaces') {
    this.baseWorkspacePath = baseWorkspacePath;
  }

  async initialize(): Promise<void> {
    // Ensure workspaces directory exists
    await fs.mkdir(this.baseWorkspacePath, { recursive: true });

    // Build the agent workspace image if it doesn't exist
    await this.buildWorkspaceImage();
  }

  private async buildWorkspaceImage(): Promise<void> {
    try {
      console.log('Building agent workspace Docker image...');

      const stream = await docker.buildImage({
        context: '.',
        src: ['Dockerfile.agent']
      }, {
        t: this.imageName
      });

      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });

      console.log('✅ Agent workspace image built successfully');
    } catch (error) {
      console.error('Failed to build workspace image:', error);
      throw error;
    }
  }

  async createWorkspace(agentId: string): Promise<AgentWorkspace> {
    const containerName = `agent-${agentId}-workspace`;
    const workspacePath = path.join(this.baseWorkspacePath, agentId);

    // Create workspace directory
    await fs.mkdir(workspacePath, { recursive: true });

    const workspace: AgentWorkspace = {
      agentId,
      containerName,
      workspacePath,
      status: 'creating',
      createdAt: new Date(),
      lastActivity: new Date()
    };

    this.workspaces.set(agentId, workspace);

    try {
      // Create and start container
      const container = await docker.createContainer({
        Image: this.imageName,
        name: containerName,
        WorkingDir: '/workspace',
        Tty: true,
        OpenStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          Binds: [`${path.resolve(workspacePath)}:/workspace`],
          Memory: 512 * 1024 * 1024, // 512MB limit
          CpuShares: 512, // Half CPU priority
          NetworkMode: 'bridge'
        },
        Env: [
          'NODE_ENV=development',
          `AGENT_ID=${agentId}`,
          'DATABASE_URL=postgresql://localhost:5432/agent_db'
        ]
      });

      await container.start();

      workspace.containerId = container.id;
      workspace.status = 'ready';

      console.log(`✅ Created workspace for agent ${agentId}`);
      return workspace;

    } catch (error) {
      workspace.status = 'error';
      console.error(`Failed to create workspace for agent ${agentId}:`, error);
      throw error;
    }
  }

  async executeCommand(agentId: string, command: string): Promise<string> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace || !workspace.containerId) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    try {
      workspace.status = 'busy';
      workspace.lastActivity = new Date();

      const container = docker.getContainer(workspace.containerId);

      const exec = await container.exec({
        Cmd: ['bash', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false
      });

      const stream = await exec.start({ Detach: false, Tty: false });

      return new Promise((resolve, reject) => {
        let output = '';

        stream.on('data', (data) => {
          output += data.toString();
        });

        stream.on('end', () => {
          workspace.status = 'ready';
          resolve(output.trim());
        });

        stream.on('error', (error) => {
          workspace.status = 'ready';
          reject(error);
        });
      });

    } catch (error) {
      workspace.status = 'ready';
      throw error;
    }
  }

  async writeFile(agentId: string, filePath: string, content: string): Promise<void> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    const fullPath = path.join(workspace.workspacePath, filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, content, 'utf8');

    workspace.lastActivity = new Date();
  }

  async readFile(agentId: string, filePath: string): Promise<string> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      throw new Error(`No workspace found for agent ${agentId}`);
    }

    const fullPath = path.join(workspace.workspacePath, filePath);
    return await fs.readFile(fullPath, 'utf8');
  }

  async createComponent(agentId: string, spec: ComponentSpec): Promise<{ component: string; types: string }> {
    // Generate TypeScript interface for props
    const propsInterface = this.generatePropsInterface(spec.name, spec.props);

    // Write props interface
    await this.writeFile(agentId, 'shared/types.ts', propsInterface);

    // Generate basic component structure
    const componentCode = this.generateComponentTemplate(spec.name);

    // Write component file
    await this.writeFile(agentId, `components/${spec.name}.tsx`, componentCode);

    // Update index file
    const indexCode = `export { default as ${spec.name} } from './${spec.name}';`;
    await this.writeFile(agentId, 'components/index.tsx', indexCode);

    return {
      component: componentCode,
      types: propsInterface
    };
  }

  async createFunction(agentId: string, spec: FunctionSpec): Promise<string> {
    // Generate function with proper TypeScript types
    const functionCode = this.generateFunctionTemplate(spec);

    // Write function file
    await this.writeFile(agentId, `functions/${spec.name}.ts`, functionCode);

    // Update index file
    const indexCode = `export { default as ${spec.name} } from './${spec.name}';`;
    await this.writeFile(agentId, 'functions/index.ts', indexCode);

    return functionCode;
  }

  async generateMigration(agentId: string, change: DatabaseChange): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14);
    const migrationName = `${timestamp}_${change.description.replace(/\s+/g, '_').toLowerCase()}`;

    // Generate Drizzle migration
    const output = await this.executeCommand(agentId, 'bun run db:generate');

    return output;
  }

  async buildComponent(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, 'bun run build:component');
  }

  async buildFunction(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, 'bun run build:function');
  }

  async runTypeCheck(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, 'bun run typecheck');
  }

  async runLinter(agentId: string): Promise<string> {
    return await this.executeCommand(agentId, 'bun run lint');
  }

  private generatePropsInterface(componentName: string, props: Record<string, any>): string {
    const propTypes = Object.entries(props).map(([key, value]) => {
      const type = this.inferTypeScriptType(value);
      return `  ${key}: ${type};`;
    }).join('\n');

    return `export interface ${componentName}Props {
${propTypes}
}`;
  }

  private generateComponentTemplate(componentName: string): string {
    return `import React from 'react';
import { ${componentName}Props } from '../shared/types';

const ${componentName}: React.FC<${componentName}Props> = (props) => {
  return (
    <div>
      {/* Implementation will be generated by agent based on requirements */}
    </div>
  );
};

export default ${componentName};
`;
  }

  private generateFunctionTemplate(spec: FunctionSpec): string {
    return `export interface ${spec.name}Input {
  ${Object.entries(spec.input).map(([key, value]) =>
    `${key}: ${this.inferTypeScriptType(value)};`
  ).join('\n  ')}
}

export interface ${spec.name}Output {
  ${Object.entries(spec.output).map(([key, value]) =>
    `${key}: ${this.inferTypeScriptType(value)};`
  ).join('\n  ')}
}

export default async function ${spec.name}(input: ${spec.name}Input): Promise<${spec.name}Output> {
  // Function implementation will be generated by agent
  throw new Error('Function not implemented');
}
`;
  }

  private inferTypeScriptType(value: any): string {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'any[]';
    if (typeof value === 'object') return 'Record<string, any>';
    return 'any';
  }

  async getWorkspaceStatus(agentId: string): Promise<AgentWorkspace | null> {
    return this.workspaces.get(agentId) || null;
  }

  async stopWorkspace(agentId: string): Promise<void> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace || !workspace.containerId) return;

    try {
      const container = docker.getContainer(workspace.containerId);
      await container.stop();
      workspace.status = 'stopped';

      console.log(`🛑 Stopped workspace for agent ${agentId}`);
    } catch (error) {
      console.error(`Failed to stop workspace for agent ${agentId}:`, error);
      throw error;
    }
  }

  async removeWorkspace(agentId: string): Promise<void> {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) return;

    try {
      if (workspace.containerId) {
        const container = docker.getContainer(workspace.containerId);
        await container.remove({ force: true });
      }

      // Clean up workspace files
      await fs.rm(workspace.workspacePath, { recursive: true, force: true });

      this.workspaces.delete(agentId);

      console.log(`🗑️ Removed workspace for agent ${agentId}`);
    } catch (error) {
      console.error(`Failed to remove workspace for agent ${agentId}:`, error);
      throw error;
    }
  }

  async listWorkspaces(): Promise<AgentWorkspace[]> {
    return Array.from(this.workspaces.values());
  }
}

export const containerManager = new ContainerManager();
