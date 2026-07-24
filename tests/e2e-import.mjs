import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";


const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const baseUrl = process.argv[2] || "http://127.0.0.1:8790";
const cohortPath = process.argv[3];
const email = process.argv[4] || "admin@test.local";
const password = process.argv[5] || "TestAdmin12345!";

if (!cohortPath) throw new Error("Uso: node tests/e2e-import.mjs <url> <cohorte.xlsx> [correo] [clave]");

const context = vm.createContext({
  console,
  TextDecoder,
  Uint8Array,
  DataView,
  ArrayBuffer,
  Blob,
  Response,
  __inflateRaw: async (input) => {
    const output = zlib.inflateRawSync(Buffer.from(input));
    return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  },
});
vm.runInContext(fs.readFileSync(path.join(appDir, "static", "clinical-engine.js"), "utf8"), context);
const engine = context.renalAlertDiagnostics;

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ email, password }),
});
assert.equal(loginResponse.status, 200);
const login = await loginResponse.json();
const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json", "X-CSRF-Token": login.csrf_token } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const result = await response.json();
  assert.ok(response.ok, result.error || `HTTP ${response.status}`);
  return result;
}

const workbook = fs.readFileSync(cohortPath);
const arrayBuffer = workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength);
const parsed = await engine.parseXlsx(arrayBuffer);
const sheet = parsed.sheets.find((candidate) => candidate.name === "V3") || parsed.sheets[0];
const transformed = engine.transformCohortRows(sheet.rows, path.basename(cohortPath), sheet.name);
assert.ok(transformed.patients.length > 2_500);
assert.ok(transformed.labs.length > 1_000);

const importId = `e2e-${Date.now()}`;
await api("/api/clinical/sync", {
  method: "POST",
  body: {
    mode: "cohort",
    patients: transformed.patients,
    labs: [],
    file_name: path.basename(cohortPath),
    import_id: importId,
    import_start: true,
    import_final: transformed.labs.length === 0,
  },
});

let added = 0;
let skipped = 0;
const batchSize = 750;
for (let start = 0; start < transformed.labs.length; start += batchSize) {
  const batch = transformed.labs.slice(start, start + batchSize);
  const result = await api("/api/clinical/sync", {
    method: "POST",
    body: {
      mode: "labs",
      labs: batch,
      file_name: path.basename(cohortPath),
      import_id: importId,
      import_final: start + batch.length >= transformed.labs.length,
    },
  });
  added += result.labs_added;
  skipped += result.labs_skipped;
}

const snapshot = await api("/api/clinical/snapshot");
assert.equal(snapshot.patients.length, transformed.patients.length);
assert.equal(snapshot.labs.length, added);
const imports = (await api("/api/imports")).imports;
const imported = imports.find((item) => item.id === importId);
assert.ok(imported);
assert.equal(imported.record_count, transformed.patients.length);
assert.equal(imported.lab_count, added);

console.log(JSON.stringify({
  patients: transformed.patients.length,
  labs_detected: transformed.labs.length,
  labs_added: added,
  labs_skipped: skipped,
}));
