import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const contract = JSON.parse(read("src/shared/schema-contract.json"));
const dbSource = read("src/main/db.ts");
const ddl = dbSource.match(/const DDL = `([\s\S]*?)`;/)?.[1];
assert.ok(ddl, "db.ts DDL missing");
for (const [table, columns] of Object.entries({
  ...contract.requiredColumns, ...contract.optionalColumns,
})) {
  const body = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`))?.[1];
  assert.ok(body, `DDL table missing: ${table}`);
  for (const column of columns) {
    assert.match(body, new RegExp(`(?:^|[,\\n])\\s*${column}\\s`, "m"),
      `DDL column missing: ${table}.${column}`);
  }
}
const built = read("html/parallax.html");
const embedded = built.match(/window\.PARALLAX_SCHEMA = (\{[^;]+\});/)?.[1];
assert.ok(embedded, "browser schema missing");
assert.deepEqual(JSON.parse(embedded), contract);
assert.deepEqual(JSON.parse(read("dist/shared/schema-contract.json")), contract);
console.log("schema contract: Electron DDL, compiled code, HTML bundle agree");
