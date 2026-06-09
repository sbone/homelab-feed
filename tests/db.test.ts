import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("database", () => {
  it("can connect to the test database", async () => {
    const { db, pool } = createDb(databaseUrl!);
    const result = await db.execute(sql`select 1 as ok`);
    await pool.end();

    expect(result.rowCount).toBe(1);
  });
});
