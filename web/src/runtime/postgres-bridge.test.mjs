import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPostgresBridge } from "./postgres-bridge.ts";

test("PostgreSQL exports restore real data; reset is ephemeral and closes sessions", async () => {
 const bridge = await createPostgresBridge();
 await bridge.exec("app","CREATE TABLE saved (n bigint); INSERT INTO saved VALUES (9223372036854775807)");
 const connection = await bridge.open();
 await assert.rejects(bridge.open(),/one PostgreSQL session/);
 await assert.rejects(bridge.drop("app"),/during a command/);
 await bridge.close(connection);
 const bytes = await bridge.serialize("app");
 const restored = await PGlite.create({loadDataDir:new Blob([bytes])});
 assert.equal(String((await restored.query("SELECT n FROM saved")).rows[0].n),"9223372036854775807");
 await restored.close();
 await bridge.drop("app");
 await assert.rejects(bridge.sql("app","SELECT * FROM saved"),/does not exist/);
 assert.equal((await bridge.sql("app","SELECT 42")).rows[0][0],"42");
});
