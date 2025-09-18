import type { Context, Next } from "hono";
import db from "../db/client";
import {
  users,
  userExtensions,
  extensions,
  functions,
  routes,
  components,
  functionLogs,
  extensionSchemas,
} from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { transpileManager, type TranspileOptions } from "./transpileManager";

interface ExtensionContext {
  userId: string;
  appId: string;
  request: {
    method: string;
    path: string;
    query: Record<string, any>;
    body: any;
    headers: Record<string, string>;
  };
  response?: {
    data: any;
    status: number;
    headers: Record<string, string>;
  };
  database: {
    query: (sql: string, params?: any[]) => Promise<any[]>;
    insert: (table: string, data: Record<string, any>) => Promise<any>;
    update: (
      table: string,
      data: Record<string, any>,
      where: Record<string, any>,
    ) => Promise<any>;
    delete: (table: string, where: Record<string, any>) => Promise<any>;
  };
}

interface ExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}

interface ComponentInjection {
  componentId: string;
  code: string;
  props: Record<string, any>;
  placement: {
    selector?: string;
    position?: "before" | "after" | "replace" | "inside";
    route?: string;
  };
}

export class ExtensionMiddleware {
  private vmPool: Map<string, string> = new Map(); // Store transpiled code instead of VM contexts
  private extensionCache: Map<string, any> = new Map();
  private cacheExpiry: number = 300000; // 5 minutes

  constructor(
    private proxyTarget: string,
    private appId: string,
  ) {}

  // Main middleware function
  async handle(c: Context, next: Next): Promise<void> {
    try {
      // Extract user context (assuming auth middleware provides this)
      const userId = c.req.header("x-user-id") as string;
      if (!userId) {
        return next(); // No user, pass through to original app
      }

      const context: ExtensionContext = {
        userId,
        appId: this.appId,
        request: {
          method: c.req.method,
          path: c.req.path,
          query: c.req.query as Record<string, any>,
          body: c.req.raw.body?.json(),
          headers: c.req.raw.headers.toJSON() as Record<string, string>,
        },
        database: this.createDatabaseInterface(userId),
      };

      // 1. Check for matching extensions
      const matchingExtensions = await this.findMatchingExtensions(context);

      if (matchingExtensions.length === 0) {
        return next(); // No extensions, pass through
      }

      // 2. Execute "before" functions
      const beforeResults = await this.executeFunctions(
        matchingExtensions.filter((ext) => ext.type === "before"),
        context,
      );

      // Update context with any modifications from before functions
      if (beforeResults.some((r) => r.success && r.data)) {
        const newHeaders = new Headers(c.req.header());
        const contentType = c.req.header("content-type");
        let newBody;

        if (contentType?.includes("application/json")) {
          // Parse as JSON
          newBody = await c.req.json().catch(() => null);
        } else if (contentType?.includes("text/plain")) {
          // Parse as text
          newBody = await c.req.text().catch(() => null);
        } else if (contentType?.includes("application/x-www-form-urlencoded")) {
          // Parse as form data
          const formData = await c.req.formData().catch(() => null);
          newBody = Object.fromEntries(formData?.entries() || []);
        } else if (contentType?.includes("multipart/form-data")) {
          // Parse as multipart form data
          const formData = await c.req.formData().catch(() => null);
          newBody = Object.fromEntries(formData?.entries() || []);
        } else {
          // Default: parse as text or reject
          newBody = await c.req.text().catch(() => null);
        }

        const modifications: Record<string, any> = beforeResults
          .filter((r) => r.success && r.data)
          .reduce((acc, r) => ({ ...acc, ...r.data }), {});

        if (modifications?.headers) {
          Object.assign(newHeaders, modifications.headers);
        }
        if (modifications.body) {
          newBody = { ...newBody, ...modifications.body };
        }
        if (modifications.query) {
          c.req.query = { ...c.req.query, ...modifications.query };
        }

        // Re-serialize the merged body based on the original Content-Type
        let updatedBody;
        if (contentType?.includes("application/json")) {
          updatedBody = JSON.stringify(newBody);
        } else if (contentType?.includes("text/plain")) {
          updatedBody = newBody.text || JSON.stringify(newBody);
        } else if (contentType?.includes("application/x-www-form-urlencoded")) {
          updatedBody = new URLSearchParams(newBody).toString();
        } else {
          updatedBody = JSON.stringify(newBody);
        }

        // Create a new Request with the updated body and original Content-Type
        const url = new URL(c.req.url);

        const newRequest = new Request(url.toString(), {
          method: c.req.method,
          headers: newHeaders,
          body: updatedBody,
        });
      }

      // 3. Check for "replace" functions (completely override the route)
      const replaceExtensions = matchingExtensions.filter(
        (ext) => ext.type === "replace",
      );
      if (replaceExtensions.length > 0) {
        const replaceResult = await this.executeFunctions(
          replaceExtensions,
          context,
        );
        const successfulReplace = replaceResult.find((r) => r.success);

        if (successfulReplace) {
          return this.sendResponse(res, successfulReplace.data, context);
        }
      }

      // 4. Proxy to original application
      const originalResponse = await this.proxyToOriginal(c.req, context);
      context.response = originalResponse;

      // 5. Execute "after" and "transform" functions
      const afterExtensions = matchingExtensions.filter(
        (ext) => ext.type === "after" || ext.type === "transform",
      );

      const afterResults = await this.executeFunctions(
        afterExtensions,
        context,
      );

      // 6. Merge results
      const finalData = this.mergeResults(originalResponse.data, afterResults);

      // 7. Inject components for this route
      const components = await this.getComponentsForRoute(userId, req.path);
      const responseWithComponents = this.injectComponents(
        finalData,
        components,
      );

      // 8. Send final response
      this.sendResponse(res, responseWithComponents, context);
    } catch (error) {
      console.error("Extension middleware error:", error);
      next(error);
    }
  }

  // Find extensions that match the current route
  private async findMatchingExtensions(
    context: ExtensionContext,
  ): Promise<any[]> {
    const cacheKey = `${context.userId}:${context.request.method}:${context.request.path}`;

    if (this.extensionCache.has(cacheKey)) {
      const cached = this.extensionCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheExpiry) {
        return cached.data;
      }
    }

    const matchingExtensions = await db
      .select({
        extensionId: extensions.id,
        functionId: functions.id,
        functionCode: functions.code,
        functionType: functions.type,
        routePath: routes.path,
        routeMethod: routes.method,
        priority: routes.priority,
        inputSchema: functions.inputSchema,
        outputSchema: functions.outputSchema,
        timeout: functions.timeout,
        environment: functions.environment,
      })
      .from(userExtensions)
      .innerJoin(extensions, eq(userExtensions.extensionId, extensions.id))
      .innerJoin(functions, eq(extensions.id, functions.extensionId))
      .innerJoin(routes, eq(functions.id, routes.functionId))
      .where(
        and(
          eq(userExtensions.userId, context.userId),
          eq(userExtensions.isEnabled, true),
          eq(routes.isActive, true),
          eq(extensions.appId, context.appId),
        ),
      )
      .orderBy(routes.priority);

    // Filter by route matching
    const matches = matchingExtensions.filter((ext) =>
      this.routeMatches(
        ext.routePath,
        ext.routeMethod,
        context.request.path,
        context.request.method,
      ),
    );

    // Cache the results
    this.extensionCache.set(cacheKey, {
      data: matches,
      timestamp: Date.now(),
    });

    return matches;
  }

  // Execute serverless functions with sandboxing
  private async executeFunctions(
    extensions: any[],
    context: ExtensionContext,
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const ext of extensions) {
      const startTime = Date.now();

      try {
        // Validate code security first
        const securityValidation = transpileManager.validateCodeSecurity(
          ext.functionCode,
        );
        if (!securityValidation.isValid) {
          throw new Error(
            `Security validation failed: ${securityValidation.issues.join(", ")}`,
          );
        }

        // Get transpiled code
        const transpiledCode = await this.getOrCreateTranspiledCode(
          ext.functionId,
          ext.functionCode,
          ext.environment || {},
        );

        // Prepare function context with safe database interface
        const functionContext = {
          request: context.request,
          response: context.response,
          user: { id: context.userId },
          database: context.database,
          console: {
            log: (...args: any[]) =>
              console.log(`[EXT:${ext.extensionId}]`, ...args),
            error: (...args: any[]) =>
              console.error(`[EXT:${ext.extensionId}]`, ...args),
          },
        };

        // Execute the transpiled code safely
        const transpileOptions: TranspileOptions = {
          timeout: ext.timeout || 30000,
          allowedEnvVars: ["NODE_ENV"],
          strictMode: true,
        };

        const result = await transpileManager.executeTranspiledCode(
          `
          (async function(context) {
            ${transpiledCode}
            if (typeof handler === 'function') {
              return await handler(context);
            }
            throw new Error('No handler function found');
          })(arguments[0])
          `,
          functionContext,
          transpileOptions,
        );

        const executionTime = Date.now() - startTime;

        results.push({
          success: true,
          data: result,
          executionTime,
        });

        // Log successful execution
        await this.logFunctionExecution(
          context.userId,
          ext.functionId,
          true,
          functionContext,
          result,
          null,
          executionTime,
          context,
        );
      } catch (error) {
        const executionTime = Date.now() - startTime;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        results.push({
          success: false,
          error: errorMessage,
          executionTime,
        });

        // Log failed execution
        await this.logFunctionExecution(
          context.userId,
          ext.functionId,
          false,
          context.request,
          null,
          errorMessage,
          executionTime,
          context,
        );
      }
    }

    return results;
  }

  // Create sandboxed VM for function execution
  private async getOrCreateTranspiledCode(
    functionId: string,
    functionCode: string,
    environment: Record<string, any>,
  ): Promise<string> {
    const cacheKey = `${functionId}_${Buffer.from(functionCode).toString("base64").slice(0, 32)}`;

    if (this.vmPool.has(cacheKey)) {
      return this.vmPool.get(cacheKey)!;
    }

    // Transpile and sanitize the code
    const transpileOptions: TranspileOptions = {
      timeout: 30000,
      allowedEnvVars: ["NODE_ENV"], // Only allow safe environment variables
      strictMode: true,
    };

    const result = await transpileManager.transpile(
      functionCode,
      transpileOptions,
    );

    if (!result.success) {
      throw new Error(`Code transpilation failed: ${result.error}`);
    }

    this.vmPool.set(cacheKey, result.transpiledCode);

    // Clean up old transpiled code periodically
    setTimeout(() => {
      this.vmPool.delete(cacheKey);
    }, 600000); // 10 minutes

    return result.transpiledCode;
  }

  // Create database interface for extensions
  private createDatabaseInterface(userId: string) {
    return {
      query: async (sqlQuery: string, params: any[] = []) => {
        // Only allow queries on user-specific extension tables
        const allowedTables = await this.getUserExtensionTables(userId);

        // Basic SQL injection protection and table access control
        if (!this.isQuerySafe(sqlQuery, allowedTables)) {
          throw new Error("Unauthorized database access");
        }

        return await db.execute(sql.raw(sqlQuery, params));
      },

      insert: async (tableName: string, data: Record<string, any>) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        return await db.execute(
          sql.raw(
            `INSERT INTO ${fullTableName} (${Object.keys(data).join(", ")}) VALUES (${Object.keys(
              data,
            )
              .map(() => "?")
              .join(", ")})`,
            Object.values(data),
          ),
        );
      },

      update: async (
        tableName: string,
        data: Record<string, any>,
        where: Record<string, any>,
      ) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        const setClause = Object.keys(data)
          .map((key) => `${key} = ?`)
          .join(", ");
        const whereClause = Object.keys(where)
          .map((key) => `${key} = ?`)
          .join(" AND ");

        return await db.execute(
          sql.raw(
            `UPDATE ${fullTableName} SET ${setClause} WHERE ${whereClause}`,
            [...Object.values(data), ...Object.values(where)],
          ),
        );
      },

      delete: async (tableName: string, where: Record<string, any>) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        const whereClause = Object.keys(where)
          .map((key) => `${key} = ?`)
          .join(" AND ");

        return await db.execute(
          sql.raw(
            `DELETE FROM ${fullTableName} WHERE ${whereClause}`,
            Object.values(where),
          ),
        );
      },
    };
  }

  // Proxy request to original application
  private async proxyToOriginal(
    req: HonoRequest,
    context: ExtensionContext,
  ): Promise<any> {
    try {
      const url = `${this.proxyTarget}${req.path}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`;

      const response = await fetch(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body:
          req.method !== "GET" && req.method !== "HEAD"
            ? JSON.stringify(req.body)
            : undefined,
      });

      const data = await response.json();

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      console.error("Proxy error:", error);
      throw new Error("Failed to proxy request to original application");
    }
  }

  // Get components that should be injected for this route
  private async getComponentsForRoute(
    userId: string,
    route: string,
  ): Promise<ComponentInjection[]> {
    const components = await db
      .select({
        id: components.id,
        code: components.code,
        props: components.props,
        placement: components.placement,
      })
      .from(userExtensions)
      .innerJoin(extensions, eq(userExtensions.extensionId, extensions.id))
      .innerJoin(components, eq(extensions.id, components.extensionId))
      .where(
        and(
          eq(userExtensions.userId, userId),
          eq(userExtensions.isEnabled, true),
        ),
      );

    // Filter components that match the current route
    return components
      .filter(
        (comp) =>
          !comp.placement?.route ||
          this.routeMatches(comp.placement.route, "GET", route, "GET"),
      )
      .map((comp) => ({
        componentId: comp.id,
        code: comp.code,
        props: comp.props || {},
        placement: comp.placement || {},
      }));
  }

  // Inject React components into the response
  private injectComponents(data: any, components: ComponentInjection[]): any {
    if (components.length === 0) {
      return data;
    }

    // Add component injection metadata to response
    return {
      ...data,
      __acacia_components: components.map((comp) => ({
        id: comp.componentId,
        code: comp.code,
        props: comp.props,
        placement: comp.placement,
      })),
    };
  }

  // Merge original response with extension results
  private mergeResults(
    originalData: any,
    extensionResults: ExecutionResult[],
  ): any {
    let mergedData = { ...originalData };

    for (const result of extensionResults) {
      if (result.success && result.data) {
        if (typeof result.data === "object" && result.data !== null) {
          mergedData = { ...mergedData, ...result.data };
        }
      }
    }

    return mergedData;
  }

  // Check if route matches pattern
  private routeMatches(
    pattern: string,
    patternMethod: string,
    requestPath: string,
    requestMethod: string,
  ): boolean {
    // Method check
    if (patternMethod !== "ALL" && patternMethod !== requestMethod) {
      return false;
    }

    // Exact match
    if (pattern === requestPath) {
      return true;
    }

    // Parameter matching (/users/:id)
    const patternParts = pattern.split("/");
    const pathParts = requestPath.split("/");

    if (patternParts.length !== pathParts.length) {
      return false;
    }

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];
      const pathPart = pathParts[i];

      if (patternPart?.startsWith(":")) {
        continue; // Parameter match
      }

      if (patternPart !== pathPart) {
        return false;
      }
    }

    return true;
  }

  // Security: Get allowed extension tables for user
  private async getUserExtensionTables(userId: string): Promise<string[]> {
    const userExtensionTables = await db
      .select({ dataTableName: userExtensions.dataTableName })
      .from(userExtensions)
      .where(eq(userExtensions.userId, userId));

    return userExtensionTables
      .map((ext) => ext.dataTableName)
      .filter(Boolean) as string[];
  }

  // Security: Validate table access
  private async validateTableAccess(
    userId: string,
    tableName: string,
  ): Promise<void> {
    const allowedTables = await this.getUserExtensionTables(userId);
    const fullTableName = `ext_${userId}_${tableName}`;

    if (!allowedTables.includes(fullTableName)) {
      throw new Error(`Access denied to table: ${tableName}`);
    }
  }

  // Security: Basic SQL injection protection
  private isQuerySafe(query: string, allowedTables: string[]): boolean {
    const lowercaseQuery = query.toLowerCase();

    // Block dangerous SQL keywords
    const dangerousKeywords = [
      "drop",
      "delete",
      "truncate",
      "alter",
      "create",
      "insert",
      "update",
    ];
    if (dangerousKeywords.some((keyword) => lowercaseQuery.includes(keyword))) {
      return false;
    }

    // Check if query only accesses allowed tables
    const referencedTables = this.extractTableNames(query);
    return referencedTables.every((table) => allowedTables.includes(table));
  }

  // Extract table names from SQL query (basic implementation)
  private extractTableNames(query: string): string[] {
    const fromMatches = query.match(/from\s+(\w+)/gi);
    const joinMatches = query.match(/join\s+(\w+)/gi);

    const tables: string[] = [];

    if (fromMatches) {
      tables.push(...fromMatches.map((match) => match.split(/\s+/)[1]));
    }

    if (joinMatches) {
      tables.push(...joinMatches.map((match) => match.split(/\s+/)[1]));
    }

    return tables;
  }

  // Log function execution for monitoring
  private async logFunctionExecution(
    userId: string,
    functionId: string,
    success: boolean,
    input: any,
    output: any,
    error: string | null,
    executionTime: number,
    context: ExtensionContext,
  ): Promise<void> {
    try {
      await db.insert(functionLogs).values({
        userId,
        functionId,
        success,
        input: JSON.stringify(input),
        output: output ? JSON.stringify(output) : null,
        error,
        executionTime,
        route: context.request.path,
        method: context.request.method,
        userAgent: context.request.headers["user-agent"] || "",
        ipAddress:
          context.request.headers["x-forwarded-for"] ||
          context.request.headers["x-real-ip"] ||
          "unknown",
      });
    } catch (logError) {
      console.error("Failed to log function execution:", logError);
    }
  }

  // Send final response
  private sendResponse(data: any, context: ExtensionContext): void {
    if (context.response?.headers) {
      Object.entries(context.response.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }

    res.status(context.response?.status || 200).json(data);
  }

  // Create dynamic extension tables when user installs extension
  async createExtensionTable(
    userId: string,
    extensionId: string,
    schema: any,
  ): Promise<string> {
    const tableName = `ext_${userId}_${extensionId}_${Date.now()}`;

    // Build CREATE TABLE statement from schema
    const columns = Object.entries(schema)
      .map(([name, config]: [string, any]) => {
        let columnDef = `${name} ${config.type.toUpperCase()}`;
        if (!config.nullable) columnDef += " NOT NULL";
        if (config.unique) columnDef += " UNIQUE";
        if (config.default !== undefined)
          columnDef += ` DEFAULT '${config.default}'`;
        return columnDef;
      })
      .join(", ");

    const createTableSQL = `CREATE TABLE ${tableName} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      ${columns}
    )`;

    await db.execute(sql.raw(createTableSQL));

    return tableName;
  }
}

// Export singleton instance
export const createExtensionMiddleware = (
  proxyTarget: string,
  appId: string,
) => {
  return new ExtensionMiddleware(proxyTarget, appId);
};
