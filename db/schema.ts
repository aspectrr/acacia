import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  jsonb,
  integer,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Applications - each app that uses the proxy
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  targetUrl: text("target_url").notNull(), // e.g., http://localhost:3001
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Extensions - the core extension definitions
export const extensions = pgTable(
  "extensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .references(() => applications.id)
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    code: text("code").notNull(), // JavaScript function as string
    enabled: boolean("enabled").default(true),
    version: integer("version").default(1),
    createdBy: text("created_by"), // User identifier
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    appIdIdx: index("extensions_app_id_idx").on(table.applicationId),
    enabledIdx: index("extensions_enabled_idx").on(table.enabled),
  }),
);

// Extension routes - defines which requests trigger each extension
export const extensionRoutes = pgTable(
  "extension_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id, { onDelete: "cascade" })
      .notNull(),
    method: text("method").notNull(), // GET, POST, PUT, DELETE, *
    pathPattern: text("path_pattern").notNull(), // /api/users or regex pattern
    patternType: text("pattern_type").notNull().default("exact"), // 'exact', 'regex', 'prefix'
    executionType: text("execution_type").notNull(), // 'before', 'after', 'replace'
    priority: integer("priority").default(0), // Higher priority runs first
  },
  (table) => ({
    extensionIdIdx: index("routes_extension_id_idx").on(table.extensionId),
    methodPathIdx: index("routes_method_path_idx").on(
      table.method,
      table.pathPattern,
    ),
  }),
);

// API discovery - automatically discovered endpoints from the target app
export const apiEndpoints = pgTable(
  "api_endpoints",
  {
    id: serial("id").primaryKey(),
    applicationId: uuid("application_id")
      .references(() => applications.id)
      .notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestSchema: jsonb("request_schema"), // JSON schema of typical request
    responseSchema: jsonb("response_schema"), // JSON schema of typical response
    sampleRequest: jsonb("sample_request"), // Example request for testing
    sampleResponse: jsonb("sample_response"), // Example response for testing
    hitCount: integer("hit_count").default(1),
    lastSeen: timestamp("last_seen").defaultNow(),
    firstSeen: timestamp("first_seen").defaultNow(),
  },
  (table) => ({
    appMethodPathIdx: index("api_endpoints_app_method_path_idx").on(
      table.applicationId,
      table.method,
      table.path,
    ),
    lastSeenIdx: index("api_endpoints_last_seen_idx").on(table.lastSeen),
  }),
);

// Extension logs - execution logs and errors
export const extensionLogs = pgTable(
  "extension_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id)
      .notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    executionType: text("execution_type").notNull(),
    success: boolean("success").notNull(),
    executionTime: integer("execution_time_ms"), // Execution time in milliseconds
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    extensionIdIdx: index("logs_extension_id_idx").on(table.extensionId),
    createdAtIdx: index("logs_created_at_idx").on(table.createdAt),
    successIdx: index("logs_success_idx").on(table.success),
  }),
);

// Extension versions - for rollback and history
export const extensionVersions = pgTable(
  "extension_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    code: text("code").notNull(),
    changeDescription: text("change_description"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    extensionVersionIdx: index("versions_extension_version_idx").on(
      table.extensionId,
      table.version,
    ),
  }),
);

// Test cases - for extension development and validation
export const extensionTestCases = pgTable(
  "extension_test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extensionId: uuid("extension_id")
      .references(() => extensions.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestData: jsonb("request_data"),
    expectedResponse: jsonb("expected_response"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    extensionIdIdx: index("test_cases_extension_id_idx").on(table.extensionId),
  }),
);

// Define relationships
export const applicationsRelations = relations(applications, ({ many }) => ({
  extensions: many(extensions),
  apiEndpoints: many(apiEndpoints),
}));

export const extensionsRelations = relations(extensions, ({ one, many }) => ({
  application: one(applications, {
    fields: [extensions.applicationId],
    references: [applications.id],
  }),
  routes: many(extensionRoutes),
  logs: many(extensionLogs),
  versions: many(extensionVersions),
  testCases: many(extensionTestCases),
}));

export const extensionRoutesRelations = relations(
  extensionRoutes,
  ({ one }) => ({
    extension: one(extensions, {
      fields: [extensionRoutes.extensionId],
      references: [extensions.id],
    }),
  }),
);

export const apiEndpointsRelations = relations(apiEndpoints, ({ one }) => ({
  application: one(applications, {
    fields: [apiEndpoints.applicationId],
    references: [applications.id],
  }),
}));

export const extensionLogsRelations = relations(extensionLogs, ({ one }) => ({
  extension: one(extensions, {
    fields: [extensionLogs.extensionId],
    references: [extensions.id],
  }),
}));

export const extensionVersionsRelations = relations(
  extensionVersions,
  ({ one }) => ({
    extension: one(extensions, {
      fields: [extensionVersions.extensionId],
      references: [extensions.id],
    }),
  }),
);

export const extensionTestCasesRelations = relations(
  extensionTestCases,
  ({ one }) => ({
    extension: one(extensions, {
      fields: [extensionTestCases.extensionId],
      references: [extensions.id],
    }),
  }),
);

// Types for TypeScript
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;

export type Extension = typeof extensions.$inferSelect;
export type NewExtension = typeof extensions.$inferInsert;

export type ExtensionRoute = typeof extensionRoutes.$inferSelect;
export type NewExtensionRoute = typeof extensionRoutes.$inferInsert;

export type ApiEndpoint = typeof apiEndpoints.$inferSelect;
export type NewApiEndpoint = typeof apiEndpoints.$inferInsert;

export type ExtensionLog = typeof extensionLogs.$inferSelect;
export type NewExtensionLog = typeof extensionLogs.$inferInsert;

export type ExtensionVersion = typeof extensionVersions.$inferSelect;
export type NewExtensionVersion = typeof extensionVersions.$inferInsert;

export type ExtensionTestCase = typeof extensionTestCases.$inferSelect;
export type NewExtensionTestCase = typeof extensionTestCases.$inferInsert;
