import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Database connection
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://acacia:acacia_password@localhost:5432/extension_proxy";
const client = postgres(connectionString);
const db = drizzle(client, { schema });

async function seed() {
  console.log("Seeding database...");

  // Insert a sample application
  const [app] = await db
    .insert(schema.applications)
    .values({
      name: "Sample Application",
      targetUrl: "http://localhost:3001",
      description: "A sample application for development",
    })
    .returning();

  console.log(`Created application: ${app.name} (${app.id})`);

  // Insert a sample extension
  const [extension] = await db
    .insert(schema.extensions)
    .values({
      applicationId: app.id,
      name: "Hello World Extension",
      description: "A simple extension that logs requests",
      code: `
function processRequest(request) {
  console.log("Hello from extension!");
  return request;
}
    `,
      enabled: true,
    })
    .returning();

  console.log(`Created extension: ${extension.name} (${extension.id})`);
  console.log("Seeding completed successfully");

  await client.end();
}

seed().catch(console.error);
