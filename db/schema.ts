import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  boolean,
  integer,
  varchar,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Enums
export const extensionStatusEnum = pgEnum("extension_status", [
  "draft",
  "published",
  "archived",
]);

export const componentTypeEnum = pgEnum("component_type", [
  "page",
  "widget",
  "modal",
  "card",
  "form",
]);

export const functionTypeEnum = pgEnum("function_type", [
  "before",
  "after",
  "replace",
  "transform",
]);

export const routeMethodEnum = pgEnum("route_method", [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "ALL",
]);

// Core Tables
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  appId: varchar("app_id", { length: 100 }).notNull(),
  role: varchar("role", { length: 50 }).default("user"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Extension Templates (created by developers)
export const extensions = pgTable(
  "extensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),
    description: text("description"),
    version: varchar("version", { length: 20 }).notNull().default("1.0.0"),
    authorId: uuid("author_id").references(() => users.id),
    appId: varchar("app_id", { length: 100 }).notNull(),
    status: extensionStatusEnum("status").default("draft"),
    category: varchar("category", { length: 100 }),
    tags: jsonb("tags").$type<string[]>(),
    icon: varchar("icon", { length: 500 }),
    screenshots: jsonb("screenshots").$type<string[]>(),
    manifest: jsonb("manifest").$type<{
      permissions: string[];
      routes: string[];
      hooks: string[];
      database_schema?: Record<string, any>;
    }>(),
    installCount: integer("install_count").default(0),
    rating: integer("rating").default(0),
    isPublic: boolean("is_public").default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("extensions_slug_idx").on(table.slug),
    index("extensions_app_id_idx").on(table.appId),
    index("extensions_status_idx").on(table.status),
  ],
);

// User-Installed Extensions
export const userExtensions = pgTable(
  "user_extensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    isEnabled: boolean("is_enabled").default(true),
    config: jsonb("config"),
    dataTableName: varchar("data_table_name", { length: 100 }),
    installedAt: timestamp("installed_at").defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [
    index("user_extensions_user_id_idx").on(table.userId),
    index("user_extensions_extension_id_idx").on(table.extensionId),
    index("user_extensions_unique_idx").on(table.userId, table.extensionId),
  ],
);

// React Components
export const components = pgTable(
  "components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    type: componentTypeEnum("type").notNull(),
    code: text("code").notNull(),
    props: jsonb("props").$type<{
      [key: string]: {
        type: string;
        required: boolean;
        default?: any;
        description?: string;
      };
    }>(),
    styleOverrides: jsonb("style_overrides"),
    placement: jsonb("placement").$type<{
      selector?: string;
      position?: "before" | "after" | "replace" | "inside";
      route?: string;
    }>(),
    dependencies: jsonb("dependencies").$type<string[]>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("components_extension_id_idx").on(table.extensionId),
    index("components_name_idx").on(table.name),
  ],
);

// Serverless Functions
export const functions = pgTable(
  "functions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    type: functionTypeEnum("type").notNull(),
    code: text("code").notNull(),
    inputSchema: jsonb("input_schema"),
    outputSchema: jsonb("output_schema"),
    timeout: integer("timeout").default(30000),
    memoryLimit: integer("memory_limit").default(512),
    environment: jsonb("environment").$type<Record<string, string>>(),
    dependencies: jsonb("dependencies").$type<string[]>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("functions_extension_id_idx").on(table.extensionId),
    index("functions_name_idx").on(table.name),
    index("functions_type_idx").on(table.type),
  ],
);

// Route Interceptions
export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    functionId: uuid("function_id").references(() => functions.id),
    path: varchar("path", { length: 500 }).notNull(),
    method: routeMethodEnum("method").notNull(),
    priority: integer("priority").default(100),
    isActive: boolean("is_active").default(true),
    matchPattern: varchar("match_pattern", { length: 500 }),
    conditions: jsonb("conditions").$type<{
      headers?: Record<string, string>;
      query?: Record<string, any>;
      body?: Record<string, any>;
    }>(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("routes_extension_id_idx").on(table.extensionId),
    index("routes_function_id_idx").on(table.functionId),
    index("routes_path_method_idx").on(table.path, table.method),
    index("routes_priority_idx").on(table.priority),
  ],
);

// Extension Data Schemas
export const extensionSchemas = pgTable(
  "extension_schemas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    tableName: varchar("table_name", { length: 100 }).notNull(),
    schema: jsonb("schema")
      .$type<{
        [columnName: string]: {
          type: "text" | "integer" | "boolean" | "timestamp" | "jsonb" | "uuid";
          nullable?: boolean;
          unique?: boolean;
          default?: any;
          references?: string;
        };
      }>()
      .notNull(),
    indexes: jsonb("indexes").$type<
      Array<{
        columns: string[];
        unique?: boolean;
        name?: string;
      }>
    >(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("extension_schemas_extension_id_idx").on(table.extensionId),
    index("extension_schemas_table_name_idx").on(table.tableName),
  ],
);

// App Configuration
export const appConfigs = pgTable(
  "app_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: varchar("app_id", { length: 100 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    baseUrl: varchar("base_url", { length: 500 }).notNull(),
    settings: jsonb("settings").$type<{
      allowUserExtensions: boolean;
      maxExtensionsPerUser: number;
      trustedDomains: string[];
      cspSettings: Record<string, any>;
      theme: Record<string, any>;
    }>(),
    hooks: jsonb("hooks").$type<{
      beforeRender?: string[];
      afterRender?: string[];
      beforeRequest?: string[];
      afterRequest?: string[];
    }>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("app_configs_app_id_idx").on(table.appId)],
);

// Function Execution Logs
export const functionLogs = pgTable(
  "function_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    functionId: uuid("function_id")
      .references(() => functions.id)
      .notNull(),
    executionTime: integer("execution_time"),
    success: boolean("success").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    route: varchar("route", { length: 500 }),
    method: varchar("method", { length: 10 }),
    userAgent: varchar("user_agent", { length: 500 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("function_logs_user_id_idx").on(table.userId),
    index("function_logs_function_id_idx").on(table.functionId),
    index("function_logs_created_at_idx").on(table.createdAt),
    index("function_logs_success_idx").on(table.success),
  ],
);

// Component Render Stats
export const componentStats = pgTable(
  "component_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    componentId: uuid("component_id")
      .references(() => components.id)
      .notNull(),
    route: varchar("route", { length: 500 }),
    renderTime: integer("render_time"),
    props: jsonb("props"),
    errors: jsonb("errors").$type<
      Array<{
        message: string;
        stack?: string;
        timestamp: string;
      }>
    >(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("component_stats_user_id_idx").on(table.userId),
    index("component_stats_component_id_idx").on(table.componentId),
    index("component_stats_created_at_idx").on(table.createdAt),
  ],
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  userExtensions: many(userExtensions),
  extensionsAuthored: many(extensions),
  functionLogs: many(functionLogs),
  componentStats: many(componentStats),
}));

export const extensionsRelations = relations(extensions, ({ one, many }) => ({
  author: one(users, {
    fields: [extensions.authorId],
    references: [users.id],
  }),
  userExtensions: many(userExtensions),
  components: many(components),
  functions: many(functions),
  routes: many(routes),
  schemas: many(extensionSchemas),
}));

export const userExtensionsRelations = relations(userExtensions, ({ one }) => ({
  user: one(users, {
    fields: [userExtensions.userId],
    references: [users.id],
  }),
  extension: one(extensions, {
    fields: [userExtensions.extensionId],
    references: [extensions.id],
  }),
}));

export const componentsRelations = relations(components, ({ one, many }) => ({
  extension: one(extensions, {
    fields: [components.extensionId],
    references: [extensions.id],
  }),
  stats: many(componentStats),
}));

export const functionsRelations = relations(functions, ({ one, many }) => ({
  extension: one(extensions, {
    fields: [functions.extensionId],
    references: [extensions.id],
  }),
  routes: many(routes),
  logs: many(functionLogs),
}));

export const routesRelations = relations(routes, ({ one }) => ({
  extension: one(extensions, {
    fields: [routes.extensionId],
    references: [extensions.id],
  }),
  function: one(functions, {
    fields: [routes.functionId],
    references: [functions.id],
  }),
}));

export const extensionSchemasRelations = relations(
  extensionSchemas,
  ({ one }) => ({
    extension: one(extensions, {
      fields: [extensionSchemas.extensionId],
      references: [extensions.id],
    }),
  }),
);

export const functionLogsRelations = relations(functionLogs, ({ one }) => ({
  user: one(users, {
    fields: [functionLogs.userId],
    references: [users.id],
  }),
  function: one(functions, {
    fields: [functionLogs.functionId],
    references: [functions.id],
  }),
}));

export const componentStatsRelations = relations(componentStats, ({ one }) => ({
  user: one(users, {
    fields: [componentStats.userId],
    references: [users.id],
  }),
  component: one(components, {
    fields: [componentStats.componentId],
    references: [components.id],
  }),
}));

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Extension = typeof extensions.$inferSelect;
export type NewExtension = typeof extensions.$inferInsert;

export type UserExtension = typeof userExtensions.$inferSelect;
export type NewUserExtension = typeof userExtensions.$inferInsert;

export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;

export type Function = typeof functions.$inferSelect;
export type NewFunction = typeof functions.$inferInsert;

export type Route = typeof routes.$inferSelect;
export type NewRoute = typeof routes.$inferInsert;

export type ExtensionSchema = typeof extensionSchemas.$inferSelect;
export type NewExtensionSchema = typeof extensionSchemas.$inferInsert;

export type AppConfig = typeof appConfigs.$inferSelect;
export type NewAppConfig = typeof appConfigs.$inferInsert;

export type FunctionLog = typeof functionLogs.$inferSelect;
export type NewFunctionLog = typeof functionLogs.$inferInsert;

export type ComponentStats = typeof componentStats.$inferSelect;
export type NewComponentStats = typeof componentStats.$inferInsert;
