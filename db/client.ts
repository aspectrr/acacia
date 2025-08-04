import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, desc, asc } from "drizzle-orm";
import * as schema from "./schema";

// Database connection
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://user:password@localhost:5432/extension_proxy";
const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Extension queries
export class ExtensionService {
  // Get all active extensions for an application
  async getActiveExtensions(applicationId: string) {
    return await db.query.extensions.findMany({
      where: and(
        eq(schema.extensions.applicationId, applicationId),
        eq(schema.extensions.enabled, true),
      ),
      with: {
        routes: true,
      },
      orderBy: [asc(schema.extensions.createdAt)],
    });
  }

  // Get extensions that match a specific route
  async getExtensionsForRoute(
    applicationId: string,
    method: string,
    path: string,
  ) {
    const extensions = await this.getActiveExtensions(applicationId);

    return extensions
      .filter((extension) =>
        extension.routes.some((route) =>
          this.routeMatches(route, method, path),
        ),
      )
      .sort((a, b) => {
        // Sort by priority (higher first)
        const aPriority = Math.max(...a.routes.map((r) => r.priority || 0));
        const bPriority = Math.max(...b.routes.map((r) => r.priority || 0));
        return bPriority - aPriority;
      });
  }

  // Check if a route matches the request
  private routeMatches(
    route: schema.ExtensionRoute,
    method: string,
    path: string,
  ): boolean {
    // Check method match (or wildcard)
    if (route.method !== "*" && route.method !== method) {
      return false;
    }

    // Check path match based on pattern type
    switch (route.patternType) {
      case "exact":
        return route.pathPattern === path;

      case "prefix":
        return path.startsWith(route.pathPattern);

      case "regex":
        try {
          const regex = new RegExp(route.pathPattern);
          return regex.test(path);
        } catch {
          return false;
        }

      default:
        return false;
    }
  }

  // Create a new extension
  async createExtension(
    data: schema.NewExtension & {
      routes: Omit<schema.NewExtensionRoute, "extensionId">[];
    },
  ) {
    return await db.transaction(async (tx) => {
      // Create the extension
      const [extension] = await tx
        .insert(schema.extensions)
        .values({
          applicationId: data.applicationId,
          name: data.name,
          description: data.description,
          code: data.code,
          enabled: data.enabled,
          createdBy: data.createdBy,
        })
        .returning();

      // Create the routes
      if (data.routes.length > 0) {
        await tx.insert(schema.extensionRoutes).values(
          data.routes.map((route) => ({
            ...route,
            extensionId: extension.id,
          })),
        );
      }

      // Create initial version
      await tx.insert(schema.extensionVersions).values({
        extensionId: extension.id,
        version: 1,
        code: data.code,
        changeDescription: "Initial version",
        createdBy: data.createdBy,
      });

      return extension;
    });
  }

  // Update extension code and create new version
  async updateExtension(
    extensionId: string,
    code: string,
    changeDescription?: string,
    updatedBy?: string,
  ) {
    return await db.transaction(async (tx) => {
      // Get current extension
      const extension = await tx.query.extensions.findFirst({
        where: eq(schema.extensions.id, extensionId),
      });

      if (!extension) {
        throw new Error("Extension not found");
      }

      // Update the extension
      const [updatedExtension] = await tx
        .update(schema.extensions)
        .set({
          code,
          version: extension.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.extensions.id, extensionId))
        .returning();

      // Create new version record
      await tx.insert(schema.extensionVersions).values({
        extensionId,
        version: updatedExtension.version,
        code,
        changeDescription,
        createdBy: updatedBy,
      });

      return updatedExtension;
    });
  }

  // Log extension execution
  async logExecution(data: schema.NewExtensionLog) {
    return await db.insert(schema.extensionLogs).values(data);
  }

  // Record API endpoint discovery
  async recordApiEndpoint(
    applicationId: string,
    method: string,
    path: string,
    requestData?: any,
    responseData?: any,
  ) {
    // Try to find existing endpoint
    const existing = await db.query.apiEndpoints.findFirst({
      where: and(
        eq(schema.apiEndpoints.applicationId, applicationId),
        eq(schema.apiEndpoints.method, method),
        eq(schema.apiEndpoints.path, path),
      ),
    });

    if (existing) {
      // Update hit count and last seen
      await db
        .update(schema.apiEndpoints)
        .set({
          hitCount: existing.hitCount + 1,
          lastSeen: new Date(),
          // Update samples if provided
          ...(requestData && { sampleRequest: requestData }),
          ...(responseData && { sampleResponse: responseData }),
        })
        .where(eq(schema.apiEndpoints.id, existing.id));
    } else {
      // Create new endpoint record
      await db.insert(schema.apiEndpoints).values({
        applicationId,
        method,
        path,
        sampleRequest: requestData,
        sampleResponse: responseData,
        hitCount: 1,
      });
    }
  }

  // Get API endpoints for exploration
  async getApiEndpoints(applicationId: string) {
    return await db.query.apiEndpoints.findMany({
      where: eq(schema.apiEndpoints.applicationId, applicationId),
      orderBy: [
        desc(schema.apiEndpoints.hitCount),
        desc(schema.apiEndpoints.lastSeen),
      ],
    });
  }

  // Get extension execution logs
  async getExtensionLogs(extensionId: string, limit = 100) {
    return await db.query.extensionLogs.findMany({
      where: eq(schema.extensionLogs.extensionId, extensionId),
      orderBy: [desc(schema.extensionLogs.createdAt)],
      limit,
    });
  }

  // Rollback to previous version
  async rollbackExtension(extensionId: string, targetVersion: number) {
    return await db.transaction(async (tx) => {
      // Get the target version
      const version = await tx.query.extensionVersions.findFirst({
        where: and(
          eq(schema.extensionVersions.extensionId, extensionId),
          eq(schema.extensionVersions.version, targetVersion),
        ),
      });

      if (!version) {
        throw new Error("Version not found");
      }

      // Update extension with old code
      const [updatedExtension] = await tx
        .update(schema.extensions)
        .set({
          code: version.code,
          updatedAt: new Date(),
        })
        .where(eq(schema.extensions.id, extensionId))
        .returning();

      return updatedExtension;
    });
  }
}

export const extensionService = new ExtensionService();
