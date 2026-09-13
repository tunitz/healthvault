import { readFileSync, writeFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { runIngest } from "@/lib/ingest";

const xml = readFileSync(new URL("../src/test/export-fixture.xml", import.meta.url), "utf8");
const zip = zipSync({ "export.xml": strToU8(xml) });
writeFileSync("/tmp/fixture.zip", zip);

const result = await runIngest(zip, "fixture.zip", zip.length);
console.log(`seeded ${result.inserted} rows (${result.duplicates} duplicates) into ${process.env.DATABASE_PATH ?? "./data/health.db"}`);
