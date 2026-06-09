import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

export async function runMigrations(): Promise<void> {
  const config = loadConfig();
  const { pool } = createDb(config.databaseUrl);

  await pool.query(`
  create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )
`);

  const migrationDir = "drizzle/migrations";
  const migrations = readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const migration of migrations) {
    const applied = await pool.query("select 1 from schema_migrations where filename = $1", [migration]);
    if (applied.rowCount && applied.rowCount > 0) {
      continue;
    }

    const sql = readFileSync(join(migrationDir, migration), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await pool.query("begin");
    try {
      for (const statement of sql) {
        await pool.query(statement);
      }
      await pool.query("insert into schema_migrations (filename) values ($1)", [migration]);
      await pool.query("commit");
      console.log(`Applied ${migration}`);
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
}
