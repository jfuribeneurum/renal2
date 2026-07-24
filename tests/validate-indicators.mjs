import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";


const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const cohortPath = process.argv[2];

if (!cohortPath) {
  throw new Error("Uso: node tests/validate-indicators.mjs <Cohorte_DM2026Junio.xlsx>");
}

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
const workbook = fs.readFileSync(cohortPath);
const arrayBuffer = workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength);
const parsed = await engine.parseXlsx(arrayBuffer);
const sheet = parsed.sheets.find((candidate) => candidate.name === "V3") || parsed.sheets[0];
const transformed = engine.transformCohortRows(sheet.rows, path.basename(cohortPath), sheet.name);
const settings = {
  watchDate: "2026-07-13",
  dueSoonDays: 29,
  renalAnnualDays: 360,
  renalQuarterDays: 90,
  hba1cDays: 119,
  lipidDays: 365,
};
const indicators = engine.computeContractIndicators(transformed.patients, transformed.labs, settings);
const actual = Object.fromEntries(indicators.map((item) => [item.id, [item.numerator, item.denominator]]));
const expected = {
  creatinineAlgorithm: [1876, 2665],
  microalbuminuriaAlgorithm: [1624, 2665],
  ldlGoal: [1700, 2510],
  bpControl: [2043, 2858],
  hba1cControl: [804, 1580],
  renalFunctionLoss: [894, 1634],
};

assert.deepEqual(actual, expected);
console.log(JSON.stringify(actual));
