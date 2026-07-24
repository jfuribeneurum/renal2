import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const html = fs.readFileSync(path.join(appDir, "static", "index.html"), "utf8");
const engine = fs.readFileSync(path.join(appDir, "static", "clinical-engine.js"), "utf8");
const shared = fs.readFileSync(path.join(appDir, "static", "shared.js"), "utf8");

const tableStart = html.lastIndexOf("<table", html.indexOf('id="patientRows"'));
const headerHtml = html.slice(tableStart, html.indexOf("</thead>", tableStart));
const headers = [...headerHtml.matchAll(/<th>(.*?)<\/th>/gs)].map((match) =>
  match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
);

const expectedHeaders = [
  "Prioridad", "Tipo de documento", "Documento", "Paciente", "TFG actual", "Fecha TFG actual", "ERC",
  "Fecha prox creatinina", "Creatinina alarma", "Creatinina cumple algoritmo", "Creatinina días venc.",
  "Creatinina días faltan", "Creatinina paciente gestionado", "Fecha prox HbA1c", "HbA1c alarma",
  "HbA1c días venc.", "HbA1c días faltan", "HbA1c paciente gestionado", "Fecha prox microalb/ACR",
  "Microalb/ACR alarma", "Microalb/ACR cumple algoritmo", "Microalb/ACR días venc.",
  "Microalb/ACR días faltan", "Microalb/ACR paciente gestionado", "Fecha prox perfil lipídico",
  "Perfil lipídico alarma", "Perfil lipídico días venc.", "Perfil lipídico días faltan",
  "Perfil lipídico paciente gestionado", "Creatinina valor/fecha", "Albuminuria/ACR valor/fecha",
  "HbA1c valor/fecha", "Perfil lipídico valor/fecha", "Acciones",
];

assert.deepEqual(headers, expectedHeaders);
assert.match(engine, /function showPatientDetail\(patientId\)/);
assert.match(engine, /class="patient-link"/);
assert.match(engine, /Cumplimiento algoritmo renal/);
assert.match(engine, /Ultimos paraclinicos/);
assert.match(shared, /releaseClinicalEngine\(\);/);
assert.match(shared, /Promise\.allSettled/);
assert.match(shared, /LAB_IMPORT_BATCH_SIZE = 750/);
assert.match(html, /id="taskWorkflow"/);
assert.match(html, /id="cohortPriorityChart"/);
assert.match(html, /id="examStatusChart"/);
assert.match(html, /id="renalStageChart"/);
assert.match(html, /id="examCoverageChart"/);
assert.match(shared, /La tarea quedó En gestión/);
assert.match(engine, /function renderCohortAnalytics\(\)/);
console.log(JSON.stringify({ columns: headers.length, detail: true, batch_import: true, task_flow: true, cohort_charts: 4 }));
