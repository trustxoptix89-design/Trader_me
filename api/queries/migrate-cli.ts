import { closeDb } from "./connection";
import { runMigrations } from "./migrate";

const applied = await runMigrations();
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database already up to date");
await closeDb();
