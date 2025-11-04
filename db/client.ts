import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "./schema";
import path from "path";

// Database connection interface
interface DatabaseConnection {
  db: PostgresJsDatabase<typeof schema>;
  client: Sql;
  close: () => Promise<void>;
  migrate: () => Promise<void>;
}

class DatabaseClient {
  private connection: DatabaseConnection | null = null;
  private migrationPath: string;

  constructor() {
    this.migrationPath = path.join(__dirname, "migrations");
  }

  async initialize(): Promise<void> {
    try {
      await this.initializePostgreSQL();
      console.log("✅ PostgreSQL database initialized");
    } catch (error) {
      console.error("❌ Database initialization failed:", error);
      throw error;
    }
  }

  private async initializePostgreSQL(): Promise<void> {
    console.log("Initializing PostgreSQL database...");
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required for PostgreSQL");
    }

    // Parse connection string or use default for development
    const connectionString = DATABASE_URL.startsWith("postgresql://")
      ? DATABASE_URL
      : `postgresql://localhost:5432/${DATABASE_URL}`;

    const client = postgres(connectionString, {
      max: 10, // Connection pool size
      idle_timeout: 20,
      connect_timeout: 10,
    });

    const db = drizzle(client, { schema });

    this.connection = {
      db,
      client,
      close: async () => {
        await client.end();
      },
      migrate: async () => {
        await migrate(db, { migrationsFolder: this.migrationPath });
      },
    };

    // Test connection
    await client`SELECT 1 as test`;
    console.log(`🐘 Connected to PostgreSQL database`);
  }

  get db() {
    console.log("Getting database connection...");
    if (!this.connection) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.connection.db;
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }

  async runMigrations(): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    try {
      await this.connection.migrate();
      console.log("✅ Database migrations completed");
    } catch (error) {
      console.error("❌ Database migration failed:", error);
      throw error;
    }
  }

  // Extension-specific database operations
  async createExtensionTable(
    tableName: string,
    schemaDefinition: any,
  ): Promise<void> {
    const columns = Object.entries(schemaDefinition)
      .map(([name, config]: [string, any]) => {
        let columnDef = `${name}`;

        // Map types for PostgreSQL
        switch (config.type) {
          case "text":
            columnDef += " TEXT";
            break;
          case "integer":
            columnDef += " INTEGER";
            break;
          case "boolean":
            columnDef += " BOOLEAN";
            break;
          case "timestamp":
            columnDef += " TIMESTAMP";
            break;
          case "jsonb":
          case "json":
            columnDef += " JSONB";
            break;
          case "uuid":
            columnDef += " UUID";
            break;
          default:
            columnDef += " TEXT";
        }

        if (!config.nullable) columnDef += " NOT NULL";
        if (config.unique) columnDef += " UNIQUE";
        if (config.default !== undefined) {
          if (typeof config.default === "string") {
            columnDef += ` DEFAULT '${config.default}'`;
          } else {
            columnDef += ` DEFAULT ${config.default}`;
          }
        }

        return columnDef;
      })
      .join(", ");

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
        ${columns ? ", " + columns : ""}
      )
    `;

    await this.db.execute(sql.raw(createTableSQL));
    console.log(`📋 Created extension table: ${tableName}`);
  }

  async dropExtensionTable(tableName: string): Promise<void> {
    await this.db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName}`));
    console.log(`🗑️ Dropped extension table: ${tableName}`);
  }

  // Health check
  async healthCheck(): Promise<{
    healthy: boolean;
    type: string;
    timestamp: Date;
    connectionCount?: number;
  }> {
    try {
      await this.db.execute(sql`SELECT 1 as health_check`);

      return {
        healthy: true,
        type: "postgresql",
        timestamp: new Date(),
      };
    } catch (error) {
      console.error("Database health check failed:", error);
      return {
        healthy: false,
        type: "postgresql",
        timestamp: new Date(),
      };
    }
  }

  // Transaction support
  async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    return await this.db.transaction(callback);
  }
}

// Create singleton instance
const dbClient = new DatabaseClient();

// Initialize database connection
let dbInitialized = false;

export const initializeDatabase = async (): Promise<void> => {
  console.log("Initializing database...");
  if (!dbInitialized) {
    await dbClient.initialize();

    // Run migrations if AUTO_MIGRATE is enabled
    if (process.env.AUTO_MIGRATE !== "false") {
      try {
        await dbClient.runMigrations();
      } catch (error) {
        console.warn(
          "⚠️ Migration failed (this might be expected for first run):",
          error,
        );
      }
    }

    dbInitialized = true;
  }
};

// Extension service for managing user extensions
export const extensionService = {
  // Get active extensions for a user
  async getActiveExtensions(userId: string, appId: string) {
    return await dbClient.db
      .select({
        extension: schema.extensions,
        userExtension: schema.userExtensions,
        components: schema.components,
        functions: schema.functions,
        routes: schema.routes,
      })
      .from(schema.userExtensions)
      .innerJoin(
        schema.extensions,
        eq(schema.userExtensions.extensionId, schema.extensions.id),
      )
      .leftJoin(
        schema.components,
        eq(schema.extensions.id, schema.components.extensionId),
      )
      .leftJoin(
        schema.functions,
        eq(schema.extensions.id, schema.functions.extensionId),
      )
      .leftJoin(
        schema.routes,
        eq(schema.functions.id, schema.routes.functionId),
      )
      .where(
        and(
          eq(schema.userExtensions.userId, userId),
          eq(schema.userExtensions.isEnabled, true),
          eq(schema.extensions.appId, appId),
        ),
      );
  },

  // Install extension for user
  async installExtension(userId: string, extensionId: string, config?: any) {
    return await dbClient.transaction(async (tx) => {
      // Check if extension exists
      const extension = await tx
        .select()
        .from(schema.extensions)
        .where(eq(schema.extensions.id, extensionId))
        .limit(1);

      if (!extension.length) {
        throw new Error("Extension not found");
      }

      // Check if already installed
      const existing = await tx
        .select()
        .from(schema.userExtensions)
        .where(
          and(
            eq(schema.userExtensions.userId, userId),
            eq(schema.userExtensions.extensionId, extensionId),
          ),
        )
        .limit(1);

      if (existing.length) {
        throw new Error("Extension already installed");
      }

      // Create extension data table if needed
      let dataTableName: string | undefined;
      const extensionSchemas = await tx
        .select()
        .from(schema.extensionSchemas)
        .where(eq(schema.extensionSchemas.extensionId, extensionId));

      if (extensionSchemas.length > 0) {
        const timestamp = Date.now();
        dataTableName = `ext_${userId.replace(/-/g, "_")}_${extensionId.replace(/-/g, "_")}_${timestamp}`;

        for (const schemaData of extensionSchemas) {
          if (schemaData.schema) {
            await dbClient.createExtensionTable(
              dataTableName,
              schemaData.schema,
            );
          }
        }
      }

      // Install extension
      const result = await tx
        .insert(schema.userExtensions)
        .values({
          userId,
          extensionId,
          config,
          dataTableName,
          isEnabled: true,
        })
        .returning();

      // Update install count
      await tx
        .update(schema.extensions)
        .set({
          installCount: sql`${schema.extensions.installCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.extensions.id, extensionId));

      return result[0];
    });
  },

  // Uninstall extension for user
  async uninstallExtension(userId: string, extensionId: string) {
    return await dbClient.transaction(async (tx) => {
      const userExtension = await tx
        .select()
        .from(schema.userExtensions)
        .where(
          and(
            eq(schema.userExtensions.userId, userId),
            eq(schema.userExtensions.extensionId, extensionId),
          ),
        )
        .limit(1);

      if (!userExtension.length) {
        throw new Error("Extension not installed");
      }

      // Drop extension data table
      if (userExtension[0].dataTableName) {
        await dbClient.dropExtensionTable(userExtension[0].dataTableName);
      }

      // Remove installation record
      await tx
        .delete(schema.userExtensions)
        .where(
          and(
            eq(schema.userExtensions.userId, userId),
            eq(schema.userExtensions.extensionId, extensionId),
          ),
        );

      // Update install count
      await tx
        .update(schema.extensions)
        .set({
          installCount: sql`GREATEST(${schema.extensions.installCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(schema.extensions.id, extensionId));

      return { success: true };
    });
  },

  // Get extension marketplace listings
  async getMarketplaceExtensions(appId: string, limit = 20, offset = 0) {
    return await dbClient.db
      .select({
        extension: schema.extensions,
      })
      .from(schema.extensions)
      .where(
        and(
          eq(schema.extensions.appId, appId),
          eq(schema.extensions.isPublic, true),
          eq(schema.extensions.status, "published"),
        ),
      )
      .groupBy(schema.extensions.id)
      .orderBy(sql`${schema.extensions.installCount} DESC`)
      .limit(limit)
      .offset(offset);
  },

  // Create a new extension (for developers)
  async createExtension(data: schema.NewExtension) {
    return await dbClient.db.insert(schema.extensions).values(data).returning();
  },

  // Get extension by slug
  async getExtensionBySlug(slug: string, appId: string) {
    return await dbClient.db.query.extensions.findFirst({
      where: and(
        eq(schema.extensions.slug, slug),
        eq(schema.extensions.appId, appId),
      ),
      with: {
        components: true,
        functions: {
          with: {
            routes: true,
          },
        },
        schemas: true,
      },
    });
  },

  // Log function execution
  async logFunctionExecution(data: schema.NewFunctionLog) {
    return await dbClient.db.insert(schema.functionLogs).values(data);
  },

  // Get function execution logs
  async getFunctionLogs(functionId: string, limit = 100) {
    return await dbClient.db
      .select()
      .from(schema.functionLogs)
      .where(eq(schema.functionLogs.functionId, functionId))
      .orderBy(sql`${schema.functionLogs.createdAt} DESC`)
      .limit(limit);
  },
};

// Export everything
export { schema, dbClient };
// export default dbClient.db;

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🔄 Shutting down database connection...");
  await dbClient.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🔄 Shutting down database connection...");
  await dbClient.close();
  process.exit(0);
});
