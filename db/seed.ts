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

  // Skipping application seeding - applications table not present in current schema

  // Insert a sample extension
  const [extension] = await db
    .insert(schema.extensions)
    .values({
      name: "Hello World Extension",
      slug: "hello-world-extension",
      appId: "sample-app",
      description: "A simple extension that logs requests",
      status: "published",
      isPublic: true,
      manifest: {
        permissions: [],
        routes: [],
        hooks: [],
      },
    })
    .returning();

  if (extension) {
    console.log(`Created extension: ${extension.name} (${extension.id})`);
  }
  console.log("Seeding completed successfully");

  await client.end();
}

seed().catch(console.error);
