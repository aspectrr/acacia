// Hono types removed
import { dbClient } from "../db/client";
const db = dbClient.db;
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
  async handle(c: any, next: any): Promise<Response | void> {
    try {
      // Extract user context (assuming auth middleware provides this)
      const userId = c.req.header("x-user-id") as string;
      if (!userId) {
        return next(); // No user, pass through to original app
      }

      // Parse request body (await as needed)
      let reqBody: any = undefined;
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/json")) {
        reqBody = await c.req.json().catch(() => undefined);
      } else if (contentType.includes("text/plain")) {
        reqBody = await c.req.text().catch(() => undefined);
      } else if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        const formData = await c.req.formData().catch(() => undefined);
        reqBody = formData ? Object.fromEntries(formData.entries()) : undefined;
      }

      // Build initial extension context
      const context: ExtensionContext = {
        userId,
        appId: this.appId,
        request: {
          method: c.req.method,
          path: c.req.path,
          query: { ...c.req.query() },
          body: reqBody,
          headers: Object.fromEntries(c.req.raw.headers.entries()),
        },
        database: this.createDatabaseInterface(userId),
      };

      // 1. Find matching extensions
      const matchingExtensions = await this.findMatchingExtensions(context);
      if (matchingExtensions.length === 0) {
        return next(); // No extensions, pass through
      }

      // 2. Execute "before" functions (request mutators)
      const beforeResults = await this.executeFunctions(
        matchingExtensions.filter((ext) => ext.functionType === "before"),
        context,
      );

      // Apply modifications from "before" extensions to the request context
      for (const result of beforeResults) {
        if (result.success && result.data) {
          if (result.data.headers) {
            Object.assign(context.request.headers, result.data.headers);
          }
          if (result.data.body) {
            context.request.body = {
              ...context.request.body,
              ...result.data.body,
            };
          }
          if (result.data.query) {
            context.request.query = {
              ...context.request.query,
              ...result.data.query,
            };
          }
        }
      }

      // 3. Check for "replace" functions (completely override the route)
      const replaceExtensions = matchingExtensions.filter(
        (ext) => ext.functionType === "replace",
      );
      if (replaceExtensions.length > 0) {
        const replaceResult = await this.executeFunctions(
          replaceExtensions,
          context,
        );
        const successfulReplace = replaceResult.find((r) => r.success);

        if (successfulReplace) {
          // Send the replaced response directly
          c.status(successfulReplace.data?.status || 200);
          if (successfulReplace.data?.headers) {
            const newHeaders = Object.fromEntries(
              Object.entries(successfulReplace.data.headers).map(([k, v]) => [
                k.toLowerCase(),
                v,
              ]),
            ) as Record<string, string>;
            for (const [k, v] of Object.entries(newHeaders)) {
              c.header(k, v);
            }
          }
          return c.json(successfulReplace.data?.body ?? successfulReplace.data);
        }
      }

      // 4. Proxy to original application (with possibly modified request)
      const proxiedResponse = await this.proxyToOriginal(
        {
          method: context.request.method,
          path: context.request.path,
          headers: context.request.headers,
          body: context.request.body,
          url: c.req.url,
        } as any, // HonoRequest shape
        context,
      );
      context.response = proxiedResponse;

      // 5. Execute "after"/"transform" functions (response mutators)
      const afterExtensions = matchingExtensions.filter(
        (ext) =>
          ext.functionType === "after" || ext.functionType === "transform",
      );
      const afterResults = await this.executeFunctions(
        afterExtensions,
        context,
      );

      // 6. Merge results into the response
      let finalData = this.mergeResults(proxiedResponse.data, afterResults);

      // 7. Inject components for this route
      const components = await this.getComponentsForRoute(
        userId,
        context.request.path,
      );
      finalData = this.injectComponents(finalData, components);

      // 8. Apply any response modifications from after extensions
      let finalStatus = proxiedResponse.status;
      let finalHeaders: Record<string, string> = { ...proxiedResponse.headers };
      for (const result of afterResults) {
        if (result.success && result.data) {
          if (result.data.status) finalStatus = result.data.status;
          if (result.data.headers)
            Object.assign(finalHeaders, result.data.headers);
        }
      }

      // 9. Send final response
      for (const [k, v] of Object.entries(finalHeaders)) {
        c.header(k, v);
      }
      c.status(finalStatus || 200);
      return c.json(finalData);
    } catch (error) {
      console.error("Extension middleware error:", error);
      await next();
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

  private safeIdentifier(name: string) {
    // Only allow letters, numbers, and underscores in identifiers
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    return sql.raw(name); // mark it as safe SQL
  }

  // Create database interface for extensions
  private createDatabaseInterface(userId: string) {
    return {
      query: async (sqlQuery: string) => {
        // Only allow queries on user-specific extension tables
        const allowedTables = await this.getUserExtensionTables(userId);

        // Basic SQL injection protection and table access control
        if (!this.isQuerySafe(sqlQuery, allowedTables)) {
          throw new Error("Unauthorized database access");
        }

        return await db.execute(sql.raw(sqlQuery));
      },

      insert: async (tableName: string, data: Record<string, any>) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        const table = this.safeIdentifier(fullTableName);
        const columns = Object.keys(data).map(this.safeIdentifier);
        const values = Object.values(data);

        const query = sql`
          insert into ${table} (${sql.join(columns, sql.raw(", "))})
          values (${sql.join(values, sql.raw(", "))})
        `;

        return await db.execute(query);
      },

      update: async (
        tableName: string,
        data: Record<string, any>,
        where: Record<string, any>,
      ) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        const table = this.safeIdentifier(fullTableName);
        const setPairs = Object.entries(data).map(
          ([key, value]) => sql`${this.safeIdentifier(key)} = ${value}`,
        );
        const wherePairs = Object.entries(where).map(
          ([key, value]) => sql`${this.safeIdentifier(key)} = ${value}`,
        );

        const query = sql`
          update ${table}
          set ${sql.join(setPairs, sql.raw(", "))}
          where ${sql.join(wherePairs, sql.raw(" and "))}
        `;

        return await db.execute(query);
      },

      delete: async (tableName: string, where: Record<string, any>) => {
        await this.validateTableAccess(userId, tableName);
        const fullTableName = `ext_${userId}_${tableName}`;

        const table = this.safeIdentifier(fullTableName);
        const wherePairs = Object.entries(where).map(
          ([key, value]) => sql`${this.safeIdentifier(key)} = ${value}`,
        );

        const query = sql`
          delete from ${table}
          where ${sql.join(wherePairs, sql.raw(" and "))}
        `;

        return await db.execute(query);
      },
    };
  }

  // Proxy request to original application
  private async proxyToOriginal(
    req: any,
    context: ExtensionContext,
  ): Promise<any> {
    try {
      const url = `${this.proxyTarget}${req.path}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`;

      const response = await fetch(url, {
        method: req.method,
        headers: req.raw.headers,
        body:
          req.method !== "GET" && req.method !== "HEAD"
            ? JSON.stringify(req.raw.body)
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
    const userComponents = await db
      .select({
        id: components.id,
        code: components.code,
        props: components.props,
        placement: components.placement,
      })
      .from(components)
      .innerJoin(extensions, eq(userExtensions.extensionId, extensions.id))
      .innerJoin(components, eq(extensions.id, components.extensionId))
      .where(
        and(
          eq(userExtensions.userId, userId),
          eq(userExtensions.isEnabled, true),
        ),
      );

    // Filter components that match the current route
    return userComponents
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
      tables.push(
        ...fromMatches
          .map((match) => {
            if (typeof match === "string") {
              const parts = match.split(/\s+/);
              return parts[1];
            }
            return undefined;
          })
          .filter((name): name is string => typeof name === "string" && !!name),
      );
    }

    if (joinMatches) {
      tables.push(
        ...joinMatches
          .map((match) => {
            if (typeof match === "string") {
              const parts = match.split(/\s+/);
              return parts[1];
            }
            return undefined;
          })
          .filter((name): name is string => typeof name === "string" && !!name),
      );
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
  // private sendResponse(data: any, context: ExtensionContext): void {
  //   if (context.response?.headers) {
  //     Object.entries(context.response.headers).forEach(([key, value]) => {
  //       c.res.setHeader(key, value);
  //     });
  //   }

  //   res.status(context.response?.status || 200).json(data);
  // }

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
