import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";


const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
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
const templatePath = path.join(appDir, "static", "plantilla_cargue_cohorte_paraclinicos.xlsx");
const workbook = fs.readFileSync(templatePath);
const arrayBuffer = workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength);
const parsed = await engine.parseXlsx(arrayBuffer);
const sheetNames = parsed.sheets.map((candidate) => candidate.name);
const sheet = parsed.sheets.find((candidate) => candidate.name === "Paraclinicos_diarios");
assert.ok(sheet, `Hojas detectadas: ${sheetNames.join(", ")}`);
const labs = engine.transformDailyLabRows(sheet.rows, path.basename(templatePath), sheet.name);
assert.ok(labs.length >= 10);
assert.ok(labs.every((lab) => lab.source));
assert.ok(labs.some((lab) => lab.type === "creatinine"));
assert.ok(labs.some((lab) => lab.type === "acr"));
assert.ok(labs.some((lab) => lab.type === "hba1c"));
assert.ok(labs.some((lab) => lab.type === "ldl"));
console.log(JSON.stringify({ sheet: sheet.name, labs: labs.length, source_required: true }));
