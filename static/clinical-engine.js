(() => {
  "use strict";

  const DB_NAME = "renal-alert-db";
  const DB_VERSION = 1;
  const PAGE_SIZE = 100;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MANAGED_STORAGE_KEY = "renal-alert-managed";
  const RENAL_ANNUAL_DAYS = 360;
  const RENAL_QUARTER_DAYS = 90;
  const RENAL_MAX_TWO_MONTHS_DAYS = 60;
  const RENAL_YEAR_WINDOW = { lower: 330, upper: 389, label: "1 ano" };
  const RENAL_THREE_TO_FOUR_WINDOW = { lower: 90, upper: 119, label: "3-4 meses" };
  const RENAL_MAX_TWO_MONTHS_WINDOW = { lower: 60, upper: 89, label: "maximo 2 meses" };

  const LAB_LABELS = {
    creatinine: "Creatinina",
    egfr: "TFG",
    albuminuria: "Albuminuria",
    acr: "Albuminuria/creatinuria",
    hba1c: "HbA1c",
    totalChol: "Colesterol total",
    hdl: "HDL",
    ldl: "LDL",
    triglycerides: "Trigliceridos",
    systolicBp: "PA sistolica",
    diastolicBp: "PA diastolica",
  };

  const CONTRACT_INDICATORS = [
    {
      id: "creatinineAlgorithm",
      shortName: "Creatinina/TFG",
      title: "Medicion de creatinina segun TFG",
      goal: 0.7,
      sheet: "Indicador 1",
    },
    {
      id: "microalbuminuriaAlgorithm",
      shortName: "Microalbuminuria",
      title: "Medicion de microalbuminuria segun algoritmo renal",
      goal: 0.6,
      sheet: "Indicador 2",
    },
    {
      id: "ldlGoal",
      shortName: "LDL",
      title: "Usuarios con LDL en meta",
      goal: 0.5,
      sheet: "Indicador 3",
    },
    {
      id: "bpControl",
      shortName: "PA",
      title: "Control de presion arterial",
      goal: 0.7,
      sheet: "Indicador 4",
    },
    {
      id: "hba1cControl",
      shortName: "HbA1c",
      title: "Usuarios diabeticos controlados",
      goal: 0.5,
      sheet: "Indicador 5",
    },
    {
      id: "renalFunctionLoss",
      shortName: "Perdida TFG",
      title: "Sin perdida anual de funcion renal",
      goal: 0.5,
      sheet: "Indicador 6",
    },
  ];

  const INDICATOR_FIELD_ORDER = [
    "creatinineAlgorithm",
    "microalbuminuriaAlgorithm",
    "ldlGoal",
    "bpControl",
    "hba1cControl",
  ];

  const state = {
    db: null,
    patients: [],
    labs: [],
    evaluated: [],
    filtered: [],
    page: 1,
    lastImport: null,
    managed: {},
  };

  const els = {};

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", init);
  }

  async function init() {
    bindElements();
    loadSettings();
    loadManagedState();
    loadTheme();
    wireEvents();
    try {
      if (window.sharedClinical?.ready) {
        await window.sharedClinical.ready;
      }
      state.db = await openDatabase();
      await loadPersistedData();
      if (window.sharedClinical?.loadSnapshot) {
        const snapshot = await window.sharedClinical.loadSnapshot();
        if (snapshot) {
          await clearStore("patients");
          await clearStore("labs");
          await putPatients(snapshot.patients || []);
          await addLabs(snapshot.labs || []);
          await loadPersistedData();
          syncManagedTaskStates(snapshot.managed_exams || []);
        }
      }
      recompute();
    } catch (error) {
      console.error(error);
      setStatus(
        "No se pudo abrir el almacenamiento local. Revisa permisos del navegador.",
        "critical",
      );
    }
  }

  function bindElements() {
    [
      "cohortFile",
      "labsFile",
      "themeToggle",
      "cohortUploadState",
      "labsUploadState",
      "loadSummary",
      "watchDate",
      "dueSoonDays",
      "renalAnnualDays",
      "renalQuarterDays",
      "hba1cDays",
      "lipidDays",
      "metricCritical",
      "metricWarning",
      "metricOk",
      "metricPatients",
      "indicatorSummaryText",
      "indicatorCards",
      "indicatorBarChart",
      "indicatorStatusChart",
      "cohortAnalyticsSummary",
      "cohortPriorityChart",
      "examStatusChart",
      "renalStageChart",
      "examCoverageChart",
      "searchInput",
      "severityFilter",
      "examFilter",
      "downloadExcelTemplate",
      "downloadTemplate",
      "exportCsv",
      "exportBackup",
      "clearData",
      "statusStrip",
      "patientRows",
      "emptyState",
      "prevPage",
      "nextPage",
      "pageInfo",
      "patientDialog",
      "detailDoc",
      "detailName",
      "detailContent",
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function wireEvents() {
    els.cohortFile.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      await handleCohortImport(file);
      event.target.value = "";
    });

    els.labsFile.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      await handleLabsImport(file);
      event.target.value = "";
    });

    setupUploadZones();

    els.themeToggle.addEventListener("click", () => {
      const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      localStorage.setItem("renal-alert-theme", nextTheme);
    });

    [
      els.watchDate,
      els.dueSoonDays,
      els.renalAnnualDays,
      els.renalQuarterDays,
      els.hba1cDays,
      els.lipidDays,
    ].forEach((control) => {
      control.addEventListener("change", () => {
        saveSettings();
        recompute();
      });
    });

    [els.searchInput, els.severityFilter, els.examFilter].forEach((control) => {
      control.addEventListener("input", () => {
        state.page = 1;
        applyFilters();
        render();
      });
    });

    els.prevPage.addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      renderRows();
    });

    els.nextPage.addEventListener("click", () => {
      const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
      state.page = Math.min(pages, state.page + 1);
      renderRows();
    });

    els.downloadExcelTemplate.addEventListener("click", downloadExcelTemplate);
    els.downloadTemplate.addEventListener("click", downloadDailyTemplate);
    els.exportCsv.addEventListener("click", exportAlertsCsv);
    els.exportBackup.addEventListener("click", exportBackupJson);
    els.clearData.addEventListener("click", clearAllData);

    els.patientRows.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-patient-id]");
      if (!button) return;
      showPatientDetail(button.dataset.patientId);
    });

    els.patientRows.addEventListener("change", async (event) => {
      const checkbox = event.target.closest("input[data-managed-key]");
      if (!checkbox) return;
      state.managed[checkbox.dataset.managedKey] = checkbox.checked;
      saveManagedState();
      if (window.sharedClinical?.manageExam) {
        try {
          await window.sharedClinical.manageExam({
            patientId: checkbox.dataset.patientId,
            examType: checkbox.dataset.labKey,
            managed: checkbox.checked,
            dueDate: checkbox.dataset.dueDate || null,
          });
        } catch {
          checkbox.checked = !checkbox.checked;
          state.managed[checkbox.dataset.managedKey] = checkbox.checked;
          saveManagedState();
        }
      }
    });

    window.addEventListener("renal:task-state", (event) => {
      updateManagedTaskState(event.detail);
    });
  }

  function setupUploadZones() {
    document.querySelectorAll("[data-upload-zone]").forEach((zone) => {
      const clearDrag = () => zone.classList.remove("dragover");
      zone.addEventListener("dragenter", (event) => {
        event.preventDefault();
        zone.classList.add("dragover");
      });
      zone.addEventListener("dragover", (event) => {
        event.preventDefault();
        zone.classList.add("dragover");
      });
      zone.addEventListener("dragleave", clearDrag);
      zone.addEventListener("drop", async (event) => {
        event.preventDefault();
        clearDrag();
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        if (zone.dataset.uploadZone === "cohortFile") {
          await handleCohortImport(file);
        } else {
          await handleLabsImport(file);
        }
      });
    });
  }

  function loadSettings() {
    const today = todayIso();
    els.watchDate.value = today;
    try {
      const saved = JSON.parse(localStorage.getItem("renal-alert-settings") || "{}");
      Object.entries(saved).forEach(([key, value]) => {
        if (els[key] && value !== undefined && value !== null) {
          els[key].value = value;
        }
      });
    } catch {
      els.watchDate.value = today;
    }
    els.dueSoonDays.value = 29;
    els.renalAnnualDays.value = RENAL_ANNUAL_DAYS;
    els.renalQuarterDays.value = RENAL_QUARTER_DAYS;
  }

  function saveSettings() {
    const settings = getSettings();
    localStorage.setItem("renal-alert-settings", JSON.stringify(settings));
  }

  function getSettings() {
    return {
      watchDate: els.watchDate.value || todayIso(),
      dueSoonDays: 29,
      renalAnnualDays: RENAL_ANNUAL_DAYS,
      renalQuarterDays: RENAL_QUARTER_DAYS,
      hba1cDays: clampInt(els.hba1cDays.value, 30, 180, 119),
      lipidDays: clampInt(els.lipidDays.value, 90, 730, 365),
    };
  }

  function loadManagedState() {
    try {
      const saved = JSON.parse(localStorage.getItem(MANAGED_STORAGE_KEY) || "{}");
      state.managed = saved && typeof saved === "object" ? saved : {};
    } catch {
      state.managed = {};
    }
  }

  function saveManagedState() {
    localStorage.setItem(MANAGED_STORAGE_KEY, JSON.stringify(state.managed));
  }

  function syncManagedTaskStates(taskStates) {
    state.managed = {};
    taskStates.forEach((task) => updateManagedTaskState(task, false));
    saveManagedState();
  }

  function updateManagedTaskState(task, rerender = true) {
    if (!task?.patient_id || !["creatinine", "albuminuria", "hba1c", "lipids"].includes(task.exam_type)) return;
    const patient = state.patients.find((item) => String(item.id) === String(task.patient_id));
    if (!patient) return;
    state.managed[managedKey(patient, task.exam_type)] = ["en_gestion", "programada", "completada"].includes(task.status);
    saveManagedState();
    if (rerender) renderRows();
  }

  function loadTheme() {
    const saved = localStorage.getItem("renal-alert-theme") || "light";
    applyTheme(saved === "dark" ? "dark" : "light");
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    if (els.themeToggle) {
      els.themeToggle.textContent = theme === "dark" ? "Modo claro" : "Modo oscuro";
      els.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    }
  }

  async function handleCohortImport(file) {
    setBusy(true);
    setUploadState("cohort", "Leyendo", "loading");
    setLoadSummary("Procesando cohorte", file.name, "Se estan detectando columnas y paraclinicos historicos.");
    setStatus(`Leyendo ${escapeHtml(file.name)}...`, "neutral");
    try {
      const parsed = await readTabularFile(file);
      const sheet = chooseBestSheet(parsed.sheets, "cohort");
      if (!sheet) throw new Error("No se encontro una hoja valida.");

      const result = transformCohortRows(sheet.rows, file.name, sheet.name);
      if (!result.patients.length) {
        throw new Error("No se detectaron pacientes con documento.");
      }

      const newLabs = dedupeLabs(result.labs);
      if (window.sharedClinical?.syncCohort) {
        await window.sharedClinical.syncCohort(result.patients, newLabs, file.name);
      }
      await clearStore("patients");
      await putPatients(result.patients);
      await addLabs(newLabs);
      await loadPersistedData();
      state.lastImport = file.name;
      recompute();

      setUploadState("cohort", "Cargada", "ok");
      setUploadState("labs", state.labs.length ? "Con datos" : "Pendiente", state.labs.length ? "ok" : "pending");
      setLoadSummary(
        "Cohorte cargada",
        `${result.patients.length.toLocaleString("es-CO")} pacientes`,
        `${newLabs.length.toLocaleString("es-CO")} paraclinicos historicos - ${sheet.name}`,
      );
      setStatus(
        `<strong>${result.patients.length.toLocaleString("es-CO")}</strong> pacientes cargados desde <strong>${escapeHtml(sheet.name)}</strong>. ` +
          `${newLabs.length.toLocaleString("es-CO")} paraclinicos historicos agregados.`,
        "ok",
      );
    } catch (error) {
      console.error(error);
      setUploadState("cohort", "Error", "critical");
      setLoadSummary("No se cargo la cohorte", error.message || "Archivo no reconocido", "Revisa que tenga documento del paciente.");
      setStatus(error.message || "No se pudo cargar la cohorte.", "critical");
    } finally {
      setBusy(false);
    }
  }

  async function handleLabsImport(file) {
    setBusy(true);
    setUploadState("labs", "Leyendo", "loading");
    setLoadSummary("Procesando paraclinicos", file.name, "Se estan cruzando resultados con la cohorte activa.");
    setStatus(`Procesando paraclinicos de ${escapeHtml(file.name)}...`, "neutral");
    try {
      const parsed = await readTabularFile(file);
      const sheet = chooseBestSheet(parsed.sheets, "labs");
      if (!sheet) throw new Error("No se encontro una hoja valida.");

      const labs = transformDailyLabRows(sheet.rows, file.name, sheet.name);
      const newLabs = dedupeLabs(labs);
      if (!newLabs.length) {
        throw new Error("No se detectaron paraclinicos nuevos.");
      }

      if (window.sharedClinical?.syncLabs) {
        await window.sharedClinical.syncLabs(newLabs, file.name);
      }

      await addLabs(newLabs);
      await loadPersistedData();
      recompute();

      const ids = new Set(state.patients.map((patient) => patient.id));
      const matched = newLabs.filter((lab) => ids.has(lab.patientId)).length;
      setUploadState("labs", "Cargados", "ok");
      setLoadSummary(
        "Paraclinicos cargados",
        `${newLabs.length.toLocaleString("es-CO")} resultados`,
        `${matched.toLocaleString("es-CO")} coinciden con la cohorte - ${sheet.name}`,
      );
      setStatus(
        `<strong>${newLabs.length.toLocaleString("es-CO")}</strong> paraclinicos agregados. ` +
          `${matched.toLocaleString("es-CO")} coinciden con la cohorte activa.`,
        "ok",
      );
    } catch (error) {
      console.error(error);
      setUploadState("labs", "Error", "critical");
      setLoadSummary("No se cargaron paraclinicos", error.message || "Archivo no reconocido", "Usa la plantilla diaria si el archivo no tiene encabezados claros.");
      setStatus(error.message || "No se pudo cargar el archivo diario.", "critical");
    } finally {
      setBusy(false);
    }
  }

  async function readTabularFile(file) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (extension === "xlsx") {
      const buffer = await file.arrayBuffer();
      return parseXlsx(buffer);
    }
    const text = await file.text();
    return {
      type: "text",
      sheets: [
        {
          name: file.name,
          rows: parseDelimitedText(text),
        },
      ],
    };
  }

  function chooseBestSheet(sheets, mode) {
    let best = null;
    let bestScore = -Infinity;
    for (const sheet of sheets) {
      const header = detectHeaderRow(sheet.rows);
      if (!header) continue;
      const headers = sheet.rows[header.index] || [];
      const idColumn = findColumn(headers, [
        ["numero", "identificacion"],
        ["documento"],
        ["cedula"],
      ]);
      const labHits = headers.filter((headerText) => inferLabTypeFromHeader(headerText)).length;
      const cohortHits = headers.filter((headerText) =>
        /paciente|usuario|nombre|apellido|ips|edad|sexo|diabetes|renal|erc/i.test(
          String(headerText),
        ),
      ).length;
      const score =
        header.score +
        Math.min(sheet.rows.length, 12000) / 10 +
        (idColumn >= 0 ? 150 : 0) +
        (mode === "labs" ? labHits * 35 : cohortHits * 12 + labHits * 10);
      if (score > bestScore) {
        bestScore = score;
        best = { ...sheet, headerIndex: header.index };
      }
    }
    return best;
  }

  function detectHeaderRow(rows) {
    let best = null;
    const keywords = [
      "identificacion",
      "documento",
      "paciente",
      "usuario",
      "creatinina",
      "albuminuria",
      "hemoglobina",
      "hba1c",
      "colesterol",
      "trigliceridos",
      "fecha",
      "erc",
      "diabetes",
    ];
    rows.slice(0, 30).forEach((row, index) => {
      const nonEmpty = row.filter((value) => String(value ?? "").trim()).length;
      if (nonEmpty < 3) return;
      const normalized = row.map(normalizeText);
      const hits = keywords.reduce(
        (count, keyword) =>
          count + (normalized.some((cell) => cell.includes(keyword)) ? 1 : 0),
        0,
      );
      const score = nonEmpty * 2 + hits * 28;
      if (!best || score > best.score) best = { index, score, nonEmpty, hits };
    });
    return best;
  }

  function transformCohortRows(rows, source, sheetName) {
    const headerInfo = detectHeaderRow(rows);
    if (!headerInfo) return { patients: [], labs: [] };
    const headers = rows[headerInfo.index].map((header) => String(header ?? "").trim());
    const columns = mapPatientColumns(headers);
    const patients = [];
    const labs = [];
    const seen = new Set();

    for (let rowIndex = headerInfo.index + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const id = cleanId(valueAt(row, columns.id));
      if (!id || seen.has(id)) continue;

      const patient = buildPatient(row, columns, id, source, sheetName, rowIndex + 1);
      patients.push(patient);
      seen.add(id);
      labs.push(...extractLabsFromWideRow(row, headers, id, source));
    }

    return { patients, labs, headerIndex: headerInfo.index, headers };
  }

  function transformDailyLabRows(rows, source, sheetName) {
    const headerInfo = detectHeaderRow(rows);
    if (!headerInfo) return [];
    const headers = rows[headerInfo.index].map((header) => String(header ?? "").trim());
    const idIndex = findColumn(headers, [
      ["numero", "identificacion"],
      ["documento"],
      ["cedula"],
    ]);
    if (idIndex < 0) return [];

    const examIndex = findColumn(headers, [
      ["examen"],
      ["prueba"],
      ["paraclinico"],
      ["laboratorio"],
    ]);
    const dateIndex = findColumn(headers, [
      ["fecha", "resultado"],
      ["fecha", "toma"],
      ["fecha"],
    ]);
    const valueIndex = findColumn(headers, [
      ["resultado"],
      ["valor"],
      ["result"],
    ]);
    const sourceIndex = findColumn(headers, [["fuente"], ["origen"], ["prestador"]]);

    const labs = [];
    const isLongFormat = examIndex >= 0 && dateIndex >= 0 && valueIndex >= 0;
    for (let rowIndex = headerInfo.index + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const patientId = cleanId(valueAt(row, idIndex));
      if (!patientId) continue;

      if (isLongFormat) {
        const type = inferLabTypeFromText(valueAt(row, examIndex));
        const date = parseDateValue(valueAt(row, dateIndex));
        const rowSource = sourceIndex >= 0 ? stringify(valueAt(row, sourceIndex)) : "";
        const labSource = rowSource || source;
        if (type === "bloodPressure") {
          const bloodPressure = parseBloodPressure(valueAt(row, valueIndex));
          if (date && bloodPressure) {
            labs.push(makeLab(patientId, "systolicBp", bloodPressure.systolic, date, labSource, sheetName));
            labs.push(makeLab(patientId, "diastolicBp", bloodPressure.diastolic, date, labSource, sheetName));
          }
          continue;
        }
        const value = parseLabNumber(valueAt(row, valueIndex), type);
        if (type && date && value !== null) {
          labs.push(makeLab(patientId, type, value, date, labSource, sheetName));
        }
      } else {
        labs.push(...extractLabsFromWideRow(row, headers, patientId, source));
      }
    }
    return labs;
  }

  function mapPatientColumns(headers) {
    return {
      id: findColumn(headers, [
        ["numero", "identificacion"],
        ["documento"],
        ["cedula"],
      ]),
      type: findColumn(headers, [["tipo", "identificacion"]]),
      firstName: findColumn(headers, [["primer", "nombre"]]),
      secondName: findColumn(headers, [["segundo", "nombre"]]),
      firstLastName: findColumn(headers, [["primer", "apellido"]]),
      secondLastName: findColumn(headers, [["segundo", "apellido"]]),
      fullName: findColumn(headers, [
        ["nombre", "completo"],
        ["nombre", "paciente"],
        ["paciente"],
      ]),
      ips: findColumn(headers, [
        ["ips", "seguimiento"],
        ["ips"],
      ]),
      programEntryDate: findColumn(headers, [
        ["fecha", "ingreso", "programa"],
        ["fecha", "ingreso"],
        ["ingreso", "programa"],
      ]),
      routeEntryDate: findColumn(headers, [
        ["fecha", "ingreso", "ruta"],
        ["ingreso", "ruta"],
      ]),
      birthDate: findColumn(headers, [["fecha", "nacimiento"]]),
      age: findColumn(headers, [["edad"]]),
      sex: findColumn(headers, [["sexo"]]),
      weight: findColumn(headers, [
        ["peso", "kg"],
        ["peso"],
        ["weight"],
      ]),
      status: findColumn(headers, [
        ["novedad", "actual"],
        ["novedad"],
        ["estado"],
      ]),
      routeStatus: findColumn(headers, [["estado", "ruta"]]),
      affiliationStatus: findColumn(headers, [["estado", "afiliacion"]]),
      erc: findColumn(headers, [
        ["enfermedad", "renal", "cronica"],
        ["diagnostico", "erc"],
        ["erc"],
      ]),
      stage: findBestStageColumn(headers),
      hta: findColumn(headers, [
        ["hipertension", "arterial"],
        ["hta"],
      ]),
      dm: findColumn(headers, [
        ["diabetes", "mellitus"],
        ["diagnostico", "dm"],
        ["grupo", "dm"],
        ["dm"],
      ]),
      gestationalDm: findColumn(headers, [
        ["diabetes", "gestacional"],
        ["dm", "gestacional"],
        ["gestacional"],
      ]),
      notEligibleBp: findColumn(headers, [
        ["no", "apto", "presion"],
        ["no", "apto", "tension"],
        ["no", "apto", "pa"],
        ["medico", "presion"],
        ["medico", "tension"],
        ["exclusion", "presion"],
        ["exclusion", "pa"],
      ]),
      notEligibleHba1c: findColumn(headers, [
        ["no", "apto", "hba1c"],
        ["no", "apto", "hemoglobina"],
        ["medico", "hba1c"],
        ["medico", "hemoglobina"],
        ["exclusion", "hba1c"],
        ["exclusion", "hemoglobina"],
      ]),
      notEligibleGoal: findColumn(headers, [
        ["no", "apto", "meta"],
        ["no", "aplica", "meta"],
        ["exclusion", "meta"],
      ]),
      indicatorFields: mapIndicatorFieldColumns(headers),
    };
  }

  function mapIndicatorFieldColumns(headers) {
    const repeatedBlocks = findIndicatorApplyBlocks(headers);
    const indicators = {};
    INDICATOR_FIELD_ORDER.forEach((id, index) => {
      indicators[id] = findNamedIndicatorBlock(headers, index + 1) || repeatedBlocks[index] || null;
    });
    indicators.renalFunctionLoss =
      findNamedIndicatorBlock(headers, 6) ||
      selectRenalFunctionLossBlock(headers, repeatedBlocks) ||
      null;
    return {
      globalApply: findColumn(headers, [
        ["aplica", "indicadores"],
        ["aplican", "indicadores"],
      ]),
      indicators,
    };
  }

  function findIndicatorApplyBlocks(headers) {
    return headers
      .map((header, index) => ({ header, index, normalized: normalizeText(header) }))
      .filter(({ normalized }) => isIndicatorApplyHeader(normalized))
      .map(({ index }) => makeIndicatorFieldBlock(headers, index));
  }

  function isIndicatorApplyHeader(normalized) {
    return (
      normalized.includes("aplica") &&
      normalized.includes("indicador") &&
      !normalized.includes("indicadores") &&
      !normalized.includes("cumple") &&
      !normalized.includes("motivo") &&
      !normalized.includes("razon")
    );
  }

  function makeIndicatorFieldBlock(headers, applyIndex) {
    return {
      apply: applyIndex,
      comply: findNearbyColumn(headers, applyIndex, [
        ["cumple"],
        ["cumplimiento"],
      ]),
      reason: findNearbyColumn(headers, applyIndex, [
        ["motivo"],
        ["razon"],
      ]),
    };
  }

  function findNamedIndicatorBlock(headers, number) {
    const apply = findStrictNamedIndicatorColumn(headers, number, ["aplica", "aplicabilidad"]);
    if (apply < 0) return null;
    const namedComply = findStrictNamedIndicatorColumn(headers, number, ["cumple", "cumplimiento"]);
    const namedReason = findStrictNamedIndicatorColumn(headers, number, ["motivo", "razon"]);
    const comply = namedComply >= 0 ? namedComply : findNearbyColumn(headers, apply, [["cumple"], ["cumplimiento"]]);
    const reason = namedReason >= 0 ? namedReason : findNearbyColumn(headers, apply, [["motivo"], ["razon"]]);
    return { apply, comply, reason };
  }

  function findStrictNamedIndicatorColumn(headers, number, fieldWords) {
    const marker = String(number);
    return headers.findIndex((header) => {
      const normalized = normalizeText(header);
      if (!normalized) return false;
      const words = normalized.split(" ");
      if (!words.includes("indicador") || !words.includes(marker)) return false;
      return fieldWords.some((word) => words.includes(normalizeText(word)));
    });
  }

  function findNearbyColumn(headers, startIndex, candidates) {
    const limit = Math.min(headers.length, startIndex + 7);
    for (let index = startIndex + 1; index < limit; index += 1) {
      const normalized = normalizeText(headers[index]);
      if (!normalized) continue;
      const matches = candidates.some((candidate) =>
        candidate.every((word) => normalized.includes(normalizeText(word))),
      );
      if (matches) return index;
    }
    return -1;
  }

  function selectRenalFunctionLossBlock(headers, repeatedBlocks) {
    const candidates = repeatedBlocks.slice(5);
    if (!candidates.length) return null;
    return candidates
      .map((block) => ({ block, score: scoreRenalFunctionBlock(headers, block) }))
      .sort((a, b) => b.score - a.score)[0]?.block;
  }

  function scoreRenalFunctionBlock(headers, block) {
    const windowText = headers
      .slice(Math.max(0, block.apply - 6), Math.min(headers.length, block.apply + 1))
      .map(normalizeText)
      .join(" ");
    let score = -block.apply / 1000;
    if (windowText.includes("ckg") || windowText.includes("cockcroft") || windowText.includes("cockroft")) {
      score += 100;
    }
    if (windowText.includes("ckdepi") || windowText.includes("ckd epi")) score -= 20;
    if (windowText.includes("tfg")) score += 10;
    return score;
  }

  function findBestStageColumn(headers) {
    let best = -1;
    let score = -Infinity;
    headers.forEach((header, index) => {
      const normalized = normalizeText(header);
      if (!normalized.includes("estadio")) return;
      const current =
        20 +
        (normalized.includes("erc") ? 80 : 0) +
        (normalized === "estadio" ? 5 : 0) -
        index / 1000;
      if (current > score) {
        score = current;
        best = index;
      }
    });
    return best;
  }

  function buildPatient(row, columns, id, source, sheetName, rowNumber) {
    const fullName = composeName(row, columns);
    const status = stringify(valueAt(row, columns.status));
    const routeStatus = stringify(valueAt(row, columns.routeStatus));
    const affiliationStatus = stringify(valueAt(row, columns.affiliationStatus));
    const stage = normalizeStage(valueAt(row, columns.stage));
    const ercText = stringify(valueAt(row, columns.erc));
    const dmText = stringify(valueAt(row, columns.dm));
    const gestationalDmText = stringify(valueAt(row, columns.gestationalDm));
    const htaText = stringify(valueAt(row, columns.hta));
    const hasGenericGoalExclusionColumn =
      columns.notEligibleGoal >= 0 &&
      columns.notEligibleGoal !== columns.notEligibleBp &&
      columns.notEligibleGoal !== columns.notEligibleHba1c;
    const notEligibleGoalText = hasGenericGoalExclusionColumn
      ? stringify(valueAt(row, columns.notEligibleGoal))
      : "";
    const gestationalDiabetes =
      isGestationalDiabetesValue(dmText) || isTruthyClinicalValue(gestationalDmText);
    const indicators = buildPatientIndicatorStatuses(row, columns.indicatorFields);
    const activeInCohort = isActiveInCohort(status, routeStatus, affiliationStatus, indicators.global);

    const patient = {
      id,
      type: stringify(valueAt(row, columns.type)),
      name: fullName || id,
      ips: stringify(valueAt(row, columns.ips)),
      programEntryDate: formatDateOrEmpty(parseDateValue(valueAt(row, columns.programEntryDate))),
      routeEntryDate: formatDateOrEmpty(parseDateValue(valueAt(row, columns.routeEntryDate))),
      birthDate: formatDateOrEmpty(parseDateValue(valueAt(row, columns.birthDate))),
      age: stringify(valueAt(row, columns.age)),
      sex: stringify(valueAt(row, columns.sex)),
      weight: parsePlainNumber(valueAt(row, columns.weight)),
      status,
      routeStatus,
      affiliationStatus,
      erc: isTruthyClinicalValue(ercText) || Boolean(stage.number),
      stage: stage.label,
      stageNumber: stage.number,
      dm: isDiabetesValue(dmText) || gestationalDiabetes,
      gestationalDiabetes,
      hta: isHtaValue(htaText),
      notEligibleBp:
        isTruthyClinicalValue(valueAt(row, columns.notEligibleBp)) ||
        goalExclusionApplies(notEligibleGoalText, "bp"),
      notEligibleHba1c:
        isTruthyClinicalValue(valueAt(row, columns.notEligibleHba1c)) ||
        goalExclusionApplies(notEligibleGoalText, "hba1c"),
      indicators,
      activeInCohort,
      tmnd: row.some((cell) => normalizeText(cell).includes("tmnd")),
      inactive: !activeInCohort,
      source,
      sheetName,
      rowNumber,
      updatedAt: new Date().toISOString(),
    };

    if (!patient.dm && normalizeText(stringify(valueAt(row, columns.dm))).includes("diabetes")) {
      patient.dm = true;
    }
    return patient;
  }

  function buildPatientIndicatorStatuses(row, indicatorFields = {}) {
    const globalRaw = stringify(valueAt(row, indicatorFields.globalApply));
    const globalApply = parseIndicatorApplyValue(globalRaw);
    const statuses = {
      global: {
        hasExplicit: Boolean(globalRaw),
        applyRaw: globalRaw,
        applies: globalApply.applies,
        reason: globalApply.reason,
      },
    };

    Object.entries(indicatorFields.indicators || {}).forEach(([id, block]) => {
      statuses[id] = buildPatientIndicatorStatus(row, block, id);
    });
    return statuses;
  }

  function buildPatientIndicatorStatus(row, block, indicatorId) {
    if (!block || block.apply < 0) {
      return {
        hasExplicit: false,
        applyRaw: "",
        applies: null,
        complianceRaw: "",
        complies: null,
        reason: "",
        data: {},
      };
    }
    const applyRaw = stringify(valueAt(row, block.apply));
    const complianceRaw = stringify(valueAt(row, block.comply));
    const reasonRaw = stringify(valueAt(row, block.reason));
    const apply = parseIndicatorApplyValue(applyRaw);
    return {
      hasExplicit: Boolean(applyRaw || complianceRaw || reasonRaw),
      applyRaw,
      applies: apply.applies,
      complianceRaw,
      complies: parseIndicatorComplianceValue(complianceRaw),
      reason: apply.applies === false ? apply.reason || reasonRaw || applyRaw : reasonRaw || apply.reason || "",
      data: buildIndicatorClinicalData(row, block, indicatorId),
    };
  }

  function buildIndicatorClinicalData(row, block, indicatorId) {
    const value = (offset) => valueAt(row, block.apply + offset);
    const number = (offset) => parsePlainNumber(value(offset));
    const date = (offset) => formatDateOrEmpty(parseDateValue(value(offset)));
    switch (indicatorId) {
      case "ldlGoal":
        return { value: number(-3), date: date(-2) };
      case "bpControl":
        return { systolic: number(-3), diastolic: number(-2), date: date(-1) };
      case "hba1cControl":
        return { value: number(-2), date: date(-1) };
      case "renalFunctionLoss":
        return {
          initialTfg: number(-5),
          initialDate: date(-4),
          currentTfg: number(-3),
          currentDate: date(-2),
          variation: number(-1),
        };
      default:
        return {};
    }
  }

  function parseIndicatorApplyValue(value) {
    const raw = stringify(value);
    const normalized = normalizeText(raw);
    if (!normalized) return { applies: null, reason: "" };
    if (normalized === "si" || normalized === "s" || normalized.startsWith("si ")) {
      return { applies: true, reason: "" };
    }
    if (normalized === "no" || normalized === "n" || normalized.startsWith("no ")) {
      return { applies: false, reason: raw };
    }
    if (normalized.includes("no aplica")) return { applies: false, reason: raw };
    return { applies: null, reason: raw };
  }

  function parseIndicatorComplianceValue(value) {
    const normalized = normalizeText(value);
    if (!normalized) return null;
    if (normalized === "si" || normalized === "s" || normalized.startsWith("si ")) return true;
    if (normalized === "no" || normalized === "n" || normalized.startsWith("no ")) return false;
    return null;
  }

  function isActiveInCohort(status, routeStatus, affiliationStatus, globalIndicatorStatus) {
    if (globalIndicatorStatus?.hasExplicit) {
      return globalIndicatorStatus.applies === true;
    }
    if (
      isInactiveStatus(status) ||
      isInactiveStatus(routeStatus) ||
      isInactiveStatus(affiliationStatus)
    ) {
      return false;
    }
    return !isNonActiveCohortStatus(status);
  }

  function isNonActiveCohortStatus(value) {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    if (isActiveStatusValue(normalized)) return false;
    return /decision|condicion clinica|traslado|retiro|cambia de residencia|dificultad|incapacidad|no puede|ruta renal|egreso|novedad de retiro/.test(
      normalized,
    );
  }

  function isActiveStatusValue(value) {
    const normalized = normalizeText(value);
    return (
      normalized === "activo" ||
      normalized === "activa" ||
      normalized === "sin novedad" ||
      normalized === "vigente" ||
      normalized === "en seguimiento"
    );
  }

  function composeName(row, columns) {
    const parts = [
      valueAt(row, columns.firstName),
      valueAt(row, columns.secondName),
      valueAt(row, columns.firstLastName),
      valueAt(row, columns.secondLastName),
    ]
      .map(stringify)
      .filter(Boolean)
      .filter((part) => normalizeText(part) !== "none" && normalizeText(part) !== "noap");
    if (parts.length) return titleCase(parts.join(" "));
    return titleCase(stringify(valueAt(row, columns.fullName)));
  }

  function extractLabsFromWideRow(row, headers, patientId, source) {
    const labs = [];
    headers.forEach((header, index) => {
      const type = inferLabTypeFromHeader(header);
      if (!type) return;
      const dateIndex = findDateColumnForLab(headers, index, type);
      const date = parseDateValue(valueAt(row, dateIndex));
      if (!date) return;
      if (type === "bloodPressure") {
        const bloodPressure = parseBloodPressure(valueAt(row, index));
        if (!bloodPressure) return;
        labs.push(makeLab(patientId, "systolicBp", bloodPressure.systolic, date, source, ""));
        labs.push(makeLab(patientId, "diastolicBp", bloodPressure.diastolic, date, source, ""));
        return;
      }
      const value = parseLabNumber(valueAt(row, index), type);
      if (value === null) return;
      labs.push(makeLab(patientId, type, value, date, source, ""));
    });
    return labs;
  }

  function findDateColumnForLab(headers, index, type) {
    const preferred = [
      index + 1,
      index - 1,
      index + 2,
      index - 2,
      index + 3,
      index - 3,
      index + 4,
      index - 4,
    ];
    for (const candidate of preferred) {
      if (candidate < 0 || candidate >= headers.length) continue;
      if (isDateHeader(headers[candidate]) && headerMatchesLab(headers[candidate], type)) {
        return candidate;
      }
    }
    for (const candidate of preferred) {
      if (candidate < 0 || candidate >= headers.length) continue;
      if (isDateHeader(headers[candidate])) return candidate;
    }

    let best = -1;
    let distance = Infinity;
    headers.forEach((header, candidate) => {
      if (!isDateHeader(header) || !headerMatchesLab(header, type)) return;
      const current = Math.abs(candidate - index);
      if (current < distance) {
        best = candidate;
        distance = current;
      }
    });
    return best;
  }

  function headerMatchesLab(header, type) {
    const normalized = normalizeText(header);
    if (!normalized) return false;
    switch (type) {
      case "creatinine":
        return normalized.includes("creatinina") && !normalized.includes("creatinuria");
      case "egfr":
        return normalized.includes("tfg") || normalized.includes("filtracion");
      case "albuminuria":
        return normalized.includes("albuminuria") && !normalized.includes("creatinuria");
      case "acr":
        return (
          normalized.includes("creatinuria") ||
          normalized.includes("cociente") ||
          normalized.includes("relacion")
        );
      case "hba1c":
        return (
          normalized.includes("hba1c") ||
          (normalized.includes("hemoglobina") &&
            /(glico|gluco|gloc|glicosilada|glucosilada)/.test(normalized))
        );
      case "totalChol":
        return normalized.includes("colesterol") && normalized.includes("total");
      case "hdl":
        return normalized.includes("hdl");
      case "ldl":
        return normalized.includes("ldl");
      case "triglycerides":
        return normalized.includes("triglicer");
      case "systolicBp":
        return normalized.includes("sistolica") || /\btas\b/.test(normalized);
      case "diastolicBp":
        return normalized.includes("diastolica") || /\btad\b/.test(normalized);
      case "bloodPressure":
        return (
          normalized.includes("presion arterial") ||
          normalized.includes("tension arterial") ||
          normalized === "ta"
        );
      default:
        return false;
    }
  }

  function inferLabTypeFromHeader(header) {
    const normalized = normalizeText(header);
    if (!normalized || isDateHeader(normalized)) return null;
    if (normalized.includes("sistolica") || /\btas\b/.test(normalized)) return "systolicBp";
    if (normalized.includes("diastolica") || /\btad\b/.test(normalized)) return "diastolicBp";
    if (
      normalized.includes("presion arterial") ||
      normalized.includes("tension arterial") ||
      normalized === "ta"
    ) {
      return "bloodPressure";
    }
    if (normalized.includes("creatinuria")) return "acr";
    if (normalized.includes("relacion") && normalized.includes("albuminuria")) return "acr";
    if (normalized.includes("cociente") && normalized.includes("albuminuria")) return "acr";
    if (normalized.includes("creatinina") && !normalized.includes("creatinuria")) {
      return "creatinine";
    }
    if (/\btfg\b/.test(normalized) || normalized.includes("filtracion glomerular")) {
      return "egfr";
    }
    if (normalized.includes("albuminuria") || normalized.includes("microalbum")) {
      return "albuminuria";
    }
    if (
      normalized.includes("hba1c") ||
      (normalized.includes("hemoglobina") &&
        /(glico|gluco|gloc|glicosilada|glucosilada)/.test(normalized))
    ) {
      return "hba1c";
    }
    if (normalized.includes("colesterol") && normalized.includes("total")) return "totalChol";
    if (/\bhdl\b/.test(normalized)) return "hdl";
    if (/\bldl\b/.test(normalized)) return "ldl";
    if (normalized.includes("triglicer")) return "triglycerides";
    return null;
  }

  function inferLabTypeFromText(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;
    if (normalized.includes("sistolica") || /\btas\b/.test(normalized)) return "systolicBp";
    if (normalized.includes("diastolica") || /\btad\b/.test(normalized)) return "diastolicBp";
    if (
      normalized.includes("presion arterial") ||
      normalized.includes("tension arterial") ||
      normalized === "ta"
    ) {
      return "bloodPressure";
    }
    if (normalized.includes("albuminuria") && normalized.includes("creatinuria")) return "acr";
    if (normalized.includes("acr") || normalized.includes("relacion albuminuria")) return "acr";
    if (normalized.includes("creatinina") && !normalized.includes("creatinuria")) {
      return "creatinine";
    }
    if (/\btfg\b/.test(normalized) || normalized.includes("filtracion")) return "egfr";
    if (normalized.includes("albuminuria") || normalized.includes("microalbum")) {
      return "albuminuria";
    }
    if (normalized.includes("hba1c") || normalized.includes("hemoglobina glico")) return "hba1c";
    if (normalized.includes("colesterol total")) return "totalChol";
    if (/\bhdl\b/.test(normalized)) return "hdl";
    if (/\bldl\b/.test(normalized)) return "ldl";
    if (normalized.includes("triglicer")) return "triglycerides";
    return null;
  }

  function makeLab(patientId, type, value, date, source, sheetName) {
    return {
      patientId,
      type,
      value,
      date,
      source,
      sheetName,
      key: `${patientId}|${type}|${date}|${value}`,
      importedAt: new Date().toISOString(),
    };
  }

  function dedupeLabs(labs) {
    const existing = new Set(state.labs.map((lab) => lab.key || labKey(lab)));
    const added = new Set();
    const unique = [];
    for (const lab of labs) {
      const key = lab.key || labKey(lab);
      if (existing.has(key) || added.has(key)) continue;
      lab.key = key;
      unique.push(lab);
      added.add(key);
    }
    return unique;
  }

  function labKey(lab) {
    return `${lab.patientId}|${lab.type}|${lab.date}|${lab.value}`;
  }

  function recompute() {
    const settings = getSettings();
    const labsByPatient = groupLabsByPatient(state.labs);
    state.evaluated = state.patients.map((patient) => {
      const labs = labsByPatient.get(patient.id) || [];
      return evaluatePatient(patient, labs, settings);
    });
    state.evaluated.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.patient.name.localeCompare(b.patient.name, "es");
    });
    applyFilters();
    render();
  }

  function groupLabsByPatient(labs) {
    const grouped = new Map();
    for (const lab of labs) {
      if (!grouped.has(lab.patientId)) grouped.set(lab.patientId, []);
      grouped.get(lab.patientId).push(lab);
    }
    for (const patientLabs of grouped.values()) {
      patientLabs.sort((a, b) => compareIsoDates(b.date, a.date));
    }
    return grouped;
  }

  function evaluatePatient(patient, labs, settings) {
    const latest = latestLabs(labs);
    const actions = [];
    const notes = [];
    const flags = {
      renal: "ok",
      hba1c: "ok",
      lipids: "ok",
    };

    const renalPlan = buildRenalAlgorithmPlan(patient, labs, latest, settings);
    if (renalPlan.latestEgfr && (!latest.egfr || compareIsoDates(renalPlan.latestEgfr.date, latest.egfr.date) > 0)) {
      latest.egfr = renalPlan.latestEgfr;
    }
    const creatinineStatus = renalPlan.creatinine.status;
    const albuminuriaStatus = renalPlan.albuminuria.status;
    const albuminuriaLab = renalPlan.albuminuria.lab;
    const scheduleMap = {
      creatinine: renalPlan.creatinine.schedule,
      hba1c: makeNotApplicableSchedule("HbA1c"),
      albuminuria: renalPlan.albuminuria.schedule,
      lipids: null,
    };

    pushDueAction(actions, flags, "renal", creatinineStatus, "creatinina");
    pushDueAction(actions, flags, "renal", albuminuriaStatus, "albuminuria o ACR");
    renalPlan.notes.forEach((note) => {
      notes.push(note.text);
      if (note.severity !== "ok") setFlag(flags, "renal", note.severity);
      if (note.action) actions.push(note.action);
    });

    if (patient.dm || patient.hta || patient.erc || patient.stageNumber) {
      Object.values(renalPlan.algorithms).forEach((algorithm) => {
        if (algorithm.summary) notes.push(algorithm.summary);
        if (algorithm.severity !== "ok") setFlag(flags, "renal", algorithm.severity);
        if (algorithm.compliance === "no") {
          actions.push(`${algorithm.label}: no cumple ventana de oportunidad del algoritmo.`);
        }
      });
    }

    if (patient.dm) {
      const hbaStatus = dueStatus(
        latest.hba1c,
        settings.hba1cDays,
        settings.dueSoonDays,
        settings.watchDate,
      );
      scheduleMap.hba1c = makeSchedule("HbA1c", latest.hba1c, hbaStatus);
      pushDueAction(actions, flags, "hba1c", hbaStatus, "HbA1c");
    } else {
      flags.hba1c = "ok";
    }

    const lipidStatus = evaluateLipidProfile(latest, settings);
    scheduleMap.lipids = makeSchedule("Perfil lipidico", lipidStatus.lab, lipidStatus);
    if (lipidStatus.severity !== "ok") {
      setFlag(flags, "lipids", lipidStatus.severity);
      actions.push(lipidStatus.message);
    }

    const severity = highestSeverity(Object.values(flags));
    const priority = severity === "critical" ? 3 : severity === "warning" ? 2 : 1;

    return {
      patient,
      labs,
      latest,
      flags,
      severity,
      priority,
      scheduleMap,
      algorithms: renalPlan.algorithms,
      schedules: Object.values(scheduleMap).filter(Boolean),
      nextDue: mostUrgentSchedule(Object.values(scheduleMap).filter(Boolean)),
      actions: actions.length ? actions : ["Sin acciones pendientes."],
      notes,
    };
  }

  function latestLabs(labs) {
    const latest = {};
    for (const lab of labs) {
      if (!latest[lab.type] || compareIsoDates(lab.date, latest[lab.type].date) > 0) {
        latest[lab.type] = lab;
      }
    }
    return latest;
  }

  function buildRenalAlgorithmPlan(patient, labs, latest, settings) {
    const notes = [];
    const atRisk = Boolean(patient.dm || patient.hta || patient.erc || patient.stageNumber);
    const creatinineAnchor = latest.creatinine || latest.egfr || null;
    const egfrLabs = buildCreatinineEgfrLabs(patient, labs, settings.watchDate);
    const albuminuriaLabs = labs
      .filter((lab) => ["albuminuria", "acr"].includes(lab.type) && Number.isFinite(Number(lab.value)) && lab.date)
      .sort((a, b) => compareIsoDates(a.date, b.date));
    const latestEgfr = newestOf(...egfrLabs);
    const latestAlbuminuria = newestOf(latest.albuminuria, latest.acr);
    const creatinineAlgorithm = evaluateCreatinineAlgorithm(egfrLabs, settings.watchDate);
    const albuminuriaAlgorithm = evaluateMicroalbuminuriaAlgorithm(albuminuriaLabs, settings.watchDate);

    let creatinineStatus;
    if (!atRisk) {
      creatinineStatus = dueStatus(latest.creatinine, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
      creatinineStatus.message = "seguimiento anual";
    } else if (!latest.creatinine && !latestEgfr) {
      creatinineStatus = dueStatus(null, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
      creatinineStatus.message = "no estudiado";
      notes.push({
        severity: "critical",
        text: "Paciente no estudiado para ERC: no cuenta con creatinina/TFG.",
        action: "Solicitar creatinina serica, calcular TFG Cockcroft-Gault y completar algoritmo renal.",
      });
    } else if (patient.stageNumber >= 3 || patient.tmnd) {
      creatinineStatus = dueStatus(latest.creatinine || latestEgfr, settings.renalQuarterDays, settings.dueSoonDays, settings.watchDate);
      creatinineStatus.message = "seguimiento ERC 3-5/TMND";
    } else if (latestEgfr && Number(latestEgfr.value) < 60) {
      const previousLow = previousLabMatching(egfrLabs, latestEgfr, (lab) => Number(lab.value) < 60);
      if (previousLow && daysBetween(previousLow.date, latestEgfr.date) >= 90) {
        creatinineStatus = dueStatus(latest.creatinine || latestEgfr, settings.renalQuarterDays, settings.dueSoonDays, settings.watchDate);
        creatinineStatus.message = "TFG <60 persistente";
        notes.push({
          severity: "warning",
          text: "TFG menor de 60 persistente por mas de 3 meses: cumple criterio funcional de ERC.",
          action: "Confirmar clasificacion ERC y continuar seguimiento renal segun estadio.",
        });
      } else {
        creatinineStatus = statusFromTarget(
          latest.creatinine || latestEgfr,
          addDays(latestEgfr.date, 90),
          settings.dueSoonDays,
          settings.watchDate,
          "repetir TFG 3-4 meses",
        );
      }
    } else if (latestEgfr && Number(latestEgfr.value) >= 60) {
      const previousEgfr = previousLab(egfrLabs, latestEgfr);
      if (previousEgfr && Number(previousEgfr.value) < 60) {
        creatinineStatus = statusFromTarget(
          latest.creatinine || latestEgfr,
          addDays(latestEgfr.date, RENAL_MAX_TWO_MONTHS_DAYS),
          settings.dueSoonDays,
          settings.watchDate,
          "tercera TFG maximo 2 meses",
        );
      } else {
        creatinineStatus = dueStatus(latest.creatinine || latestEgfr, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
        creatinineStatus.message = "seguimiento anual";
      }
    } else {
      creatinineStatus = dueStatus(latest.creatinine, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
      creatinineStatus.message = "calcular TFG";
      notes.push({
        severity: "warning",
        text: "Hay creatinina, pero no se encontro TFG registrada.",
        action: "Calcular TFG por Cockcroft-Gault con edad, peso, sexo y creatinina.",
      });
    }

    if (atRisk && !(patient.stageNumber >= 3 || patient.tmnd) && creatinineAlgorithm.nextWindow) {
      creatinineStatus = statusFromAlgorithmWindow(
        creatinineAlgorithm.nextWindow,
        settings.watchDate,
        creatinineAlgorithm.nextMessage,
      );
    }

    let albuminuriaStatus;
    if (!atRisk) {
      albuminuriaStatus = dueStatus(latestAlbuminuria, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
      albuminuriaStatus.message = "seguimiento anual";
    } else if (!latestAlbuminuria) {
      if (latestEgfr && Number(latestEgfr.value) >= 60) {
        albuminuriaStatus = statusFromTarget(
          null,
          addDays(latestEgfr.date, 151),
          settings.dueSoonDays,
          settings.watchDate,
          "albuminuria/ACR maximo 6 meses",
        );
      } else {
        albuminuriaStatus = dueStatus(null, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
        albuminuriaStatus.message = "sin albuminuria/ACR";
      }
    } else if (Number(latestAlbuminuria.value) >= 30) {
      const previousHigh = previousLabMatching(albuminuriaLabs, latestAlbuminuria, (lab) => Number(lab.value) >= 30);
      if (previousHigh && daysBetween(previousHigh.date, latestAlbuminuria.date) >= 90) {
        albuminuriaStatus = dueStatus(latestAlbuminuria, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
        albuminuriaStatus.message = "albuminuria persistente";
        notes.push({
          severity: "warning",
          text: "Albuminuria/ACR >=30 persistente por mas de 3 meses: cumple criterio de dano renal.",
          action: "Confirmar clasificacion ERC y seguimiento renal.",
        });
      } else {
        albuminuriaStatus = statusFromTarget(
          latestAlbuminuria,
          addDays(latestAlbuminuria.date, 90),
          settings.dueSoonDays,
          settings.watchDate,
          "repetir albuminuria 3-4 meses",
        );
      }
    } else {
      const previousAlbuminuria = previousLab(albuminuriaLabs, latestAlbuminuria);
      if (previousAlbuminuria && Number(previousAlbuminuria.value) >= 30) {
        albuminuriaStatus = statusFromTarget(
          latestAlbuminuria,
          addDays(latestAlbuminuria.date, RENAL_MAX_TWO_MONTHS_DAYS),
          settings.dueSoonDays,
          settings.watchDate,
          "tercera albuminuria maximo 2 meses",
        );
      } else {
        albuminuriaStatus = dueStatus(latestAlbuminuria, settings.renalAnnualDays, settings.dueSoonDays, settings.watchDate);
        albuminuriaStatus.message = "seguimiento anual";
      }
    }

    if (atRisk && latestAlbuminuria && albuminuriaAlgorithm.nextWindow) {
      albuminuriaStatus = statusFromAlgorithmWindow(
        albuminuriaAlgorithm.nextWindow,
        settings.watchDate,
        albuminuriaAlgorithm.nextMessage,
      );
    }

    if (latestEgfr && Number(latestEgfr.value) >= 60 && latestAlbuminuria) {
      const gap = Math.abs(daysBetween(latestEgfr.date, latestAlbuminuria.date));
      if (gap > 180) {
        notes.push({
          severity: "warning",
          text: `TFG >=60 y albuminuria/ACR separadas por ${gap} dias; el algoritmo permite maximo 6 meses.`,
          action: "Repetir o documentar albuminuria/ACR dentro del intervalo valido del algoritmo.",
        });
      }
    }

    return {
      creatinine: {
        status: creatinineStatus,
        schedule: makeSchedule("Creatinina", latest.creatinine || latestEgfr, creatinineStatus),
      },
      albuminuria: {
        status: albuminuriaStatus,
        lab: latestAlbuminuria,
        schedule: makeSchedule("Microalbuminuria/ACR", latestAlbuminuria, albuminuriaStatus),
      },
      notes,
      latestEgfr,
      algorithms: {
        creatinine: creatinineAlgorithm,
        albuminuria: albuminuriaAlgorithm,
      },
    };
  }

  function previousLab(sortedLabs, currentLab) {
    const index = sortedLabs.findIndex((lab) => lab === currentLab || labKey(lab) === labKey(currentLab));
    if (index > 0) return sortedLabs[index - 1];
    return null;
  }

  function previousLabMatching(sortedLabs, currentLab, predicate) {
    const index = sortedLabs.findIndex((lab) => lab === currentLab || labKey(lab) === labKey(currentLab));
    const end = index >= 0 ? index : sortedLabs.length;
    for (let i = end - 1; i >= 0; i -= 1) {
      if (predicate(sortedLabs[i])) return sortedLabs[i];
    }
    return null;
  }

  function buildCreatinineEgfrLabs(patient, labs, watchDate) {
    const byDate = new Map();
    labs
      .filter((lab) => lab.type === "egfr" && Number.isFinite(Number(lab.value)) && lab.date)
      .forEach((lab) => {
        byDate.set(lab.date, { ...lab, algorithmValue: Number(lab.value) });
      });

    labs
      .filter((lab) => lab.type === "creatinine" && Number.isFinite(Number(lab.value)) && lab.date)
      .forEach((lab) => {
        if (byDate.has(lab.date)) return;
        const age = ageForPatient(patient, lab.date || watchDate);
        const tfg = calculateCockcroftGault(Number(lab.value), age, patient.sex, patient.weight);
        if (!Number.isFinite(tfg)) return;
        byDate.set(lab.date, {
          patientId: lab.patientId,
          type: "egfr",
          value: tfg,
          algorithmValue: tfg,
          date: lab.date,
          source: "Cockcroft-Gault",
          sheetName: lab.sheetName,
          derived: true,
          creatinineValue: Number(lab.value),
          weight: patient.weight,
          key: `${lab.patientId}|egfr-calculada|${lab.date}|${tfg}`,
        });
      });

    return [...byDate.values()].sort((a, b) => compareIsoDates(a.date, b.date));
  }

  function calculateCockcroftGault(creatinine, age, sex, weight) {
    if (!Number.isFinite(creatinine) || !Number.isFinite(age) || !Number.isFinite(weight)) return null;
    if (creatinine <= 0 || weight <= 0) return null;
    const factor = /f|femenino|mujer/i.test(normalizeText(sex)) ? 0.85 : 1;
    return Math.round((((140 - age) * weight) / (72 * creatinine)) * factor * 100) / 100;
  }

  function ageForPatient(patient, dateIso) {
    const explicitAge = parsePlainNumber(patient.age);
    if (Number.isFinite(explicitAge) && explicitAge > 0) return explicitAge;
    if (!patient.birthDate) return null;
    const birthTime = Date.parse(`${patient.birthDate}T00:00:00Z`);
    const refTime = Date.parse(`${dateIso || todayIso()}T00:00:00Z`);
    if (!Number.isFinite(birthTime) || !Number.isFinite(refTime)) return null;
    const birth = new Date(birthTime);
    const ref = new Date(refTime);
    let age = ref.getUTCFullYear() - birth.getUTCFullYear();
    const beforeBirthday =
      ref.getUTCMonth() < birth.getUTCMonth() ||
      (ref.getUTCMonth() === birth.getUTCMonth() && ref.getUTCDate() < birth.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age;
  }

  function evaluateCreatinineAlgorithm(records, watchDate) {
    return evaluateAlgorithmByScript({
      label: "Creatinina/TFG",
      records,
      watchDate,
      isAbnormal: (value) => Number(value) < 60,
      normalText: "TFG >=60",
      abnormalText: "TFG <60",
      buildSequence: buildCreatinineSequence,
      finalize: finalizeCreatinineSequence,
      complies: creatinineSequenceComplies,
    });
  }

  function buildCreatinineSequence(first, records) {
    const firstLow = Number(first.value) < 60;
    const sequence = createAlgorithmSequence(first);
    const remaining = records.filter((lab) => compareIsoDates(lab.date, first.date) > 0);
    const secondWindow = firstLow ? RENAL_THREE_TO_FOUR_WINDOW : RENAL_YEAR_WINDOW;
    sequence.windows.second = secondWindow;
    sequence.second = chooseRecordInWindow(remaining, first.date, secondWindow);

    if (!sequence.second) return sequence;

    const secondLow = Number(sequence.second.value) < 60;
    const afterSecond = remaining.filter((lab) => labKey(lab) !== labKey(sequence.second) && compareIsoDates(lab.date, sequence.second.date) > 0);
    let thirdWindow = null;

    if (!firstLow && !secondLow) {
      thirdWindow = RENAL_YEAR_WINDOW;
    } else if (!firstLow && secondLow) {
      thirdWindow = RENAL_THREE_TO_FOUR_WINDOW;
    } else if (firstLow && !secondLow) {
      thirdWindow = RENAL_MAX_TWO_MONTHS_WINDOW;
    }

    if (thirdWindow) {
      sequence.windows.third = thirdWindow;
      sequence.third = chooseRecordInWindow(afterSecond, sequence.second.date, thirdWindow);
    }

    if (!sequence.third) return sequence;

    const thirdLow = Number(sequence.third.value) < 60;
    const afterThird = afterSecond.filter((lab) => labKey(lab) !== labKey(sequence.third) && compareIsoDates(lab.date, sequence.third.date) > 0);
    let fourthWindow = null;

    if (!firstLow && secondLow && !thirdLow) {
      fourthWindow = RENAL_MAX_TWO_MONTHS_WINDOW;
    } else if (!firstLow && !secondLow && thirdLow) {
      fourthWindow = RENAL_THREE_TO_FOUR_WINDOW;
    }

    if (fourthWindow) {
      sequence.windows.fourth = fourthWindow;
      sequence.fourth = chooseRecordInWindow(afterThird, sequence.third.date, fourthWindow);
    }

    return sequence;
  }

  function creatinineSequenceComplies(sequence) {
    if (!sequence.first || !sequence.second) return false;
    const firstLow = Number(sequence.first.value) < 60;
    const secondLow = Number(sequence.second.value) < 60;

    if (!firstLow && !secondLow) {
      if (sequence.third && Number(sequence.third.value) < 60) return Boolean(sequence.fourth);
      return true;
    }
    if (firstLow && secondLow) return true;
    if (!firstLow && secondLow) {
      if (!sequence.third) return false;
      if (Number(sequence.third.value) < 60) return true;
      return Boolean(sequence.fourth);
    }
    return Boolean(sequence.third);
  }

  function finalizeCreatinineSequence(sequence, watchDate, config) {
    const firstLow = Number(sequence.first.value) < 60;
    const second = sequence.second;
    const third = sequence.third;
    const fourth = sequence.fourth;
    let result = null;
    let nextWindow = null;

    if (!second) {
      nextWindow = buildAlgorithmWindow(sequence.first, firstLow ? RENAL_THREE_TO_FOUR_WINDOW : RENAL_YEAR_WINDOW);
    } else {
      const secondLow = Number(second.value) < 60;
      if (!third) {
        if (!firstLow && !secondLow) result = "SE DESCARTA ERC";
        else if (firstLow && secondLow) result = "SE CONFIRMA ERC";
        else if (!firstLow && secondLow) nextWindow = buildAlgorithmWindow(second, RENAL_THREE_TO_FOUR_WINDOW);
        else nextWindow = buildAlgorithmWindow(second, RENAL_MAX_TWO_MONTHS_WINDOW);
      } else {
        const thirdLow = Number(third.value) < 60;
        if (!firstLow && secondLow) {
          if (thirdLow) result = "SE CONFIRMA ERC";
          else if (fourth) result = Number(fourth.value) >= 60 ? "SE DESCARTA ERC" : "SE CONFIRMA ERC";
          else nextWindow = buildAlgorithmWindow(third, RENAL_MAX_TWO_MONTHS_WINDOW);
        } else if (!firstLow && !secondLow && thirdLow) {
          if (fourth) result = Number(fourth.value) >= 60 ? "SE DESCARTA ERC" : "SE CONFIRMA ERC";
          else nextWindow = buildAlgorithmWindow(third, RENAL_THREE_TO_FOUR_WINDOW);
        } else if (!secondLow && !thirdLow) {
          result = "SE DESCARTA ERC";
        } else if (secondLow && thirdLow) {
          result = "SE CONFIRMA ERC";
        } else if (!firstLow && !thirdLow) {
          result = "SE DESCARTA ERC";
        } else if (firstLow && thirdLow) {
          result = "SE CONFIRMA ERC";
        } else {
          nextWindow = buildAlgorithmWindow(third, RENAL_MAX_TWO_MONTHS_WINDOW);
        }
      }
    }

    return finalizeAlgorithmResult(sequence, config, watchDate, result, nextWindow);
  }

  function evaluateMicroalbuminuriaAlgorithm(records, watchDate) {
    return evaluateAlgorithmByScript({
      label: "Microalbuminuria/ACR",
      records,
      watchDate,
      isAbnormal: (value) => Number(value) >= 30,
      normalText: "Microalbuminuria/ACR <30",
      abnormalText: "Microalbuminuria/ACR >=30",
      buildSequence: buildMicroalbuminuriaSequence,
      finalize: finalizeMicroalbuminuriaSequence,
      complies: microalbuminuriaSequenceComplies,
    });
  }

  function buildMicroalbuminuriaSequence(first, records) {
    const firstHigh = Number(first.value) >= 30;
    const sequence = createAlgorithmSequence(first);
    const remaining = records.filter((lab) => compareIsoDates(lab.date, first.date) > 0);
    const secondWindow = firstHigh ? RENAL_THREE_TO_FOUR_WINDOW : RENAL_YEAR_WINDOW;
    sequence.windows.second = secondWindow;
    sequence.second = chooseRecordInWindow(remaining, first.date, secondWindow);

    if (!sequence.second) return sequence;

    const secondHigh = Number(sequence.second.value) >= 30;
    const afterSecond = remaining.filter((lab) => labKey(lab) !== labKey(sequence.second) && compareIsoDates(lab.date, sequence.second.date) > 0);
    let thirdWindow = null;

    if (!firstHigh && secondHigh) {
      thirdWindow = RENAL_THREE_TO_FOUR_WINDOW;
    } else if (!firstHigh && !secondHigh) {
      thirdWindow = RENAL_YEAR_WINDOW;
    } else if (firstHigh && !secondHigh) {
      thirdWindow = RENAL_MAX_TWO_MONTHS_WINDOW;
    }

    if (thirdWindow) {
      sequence.windows.third = thirdWindow;
      sequence.third = chooseRecordInWindow(afterSecond, sequence.second.date, thirdWindow);
    }

    if (!sequence.third) return sequence;

    const thirdHigh = Number(sequence.third.value) >= 30;
    const afterThird = afterSecond.filter((lab) => labKey(lab) !== labKey(sequence.third) && compareIsoDates(lab.date, sequence.third.date) > 0);
    let fourthWindow = null;

    if (!firstHigh && secondHigh && !thirdHigh) {
      fourthWindow = RENAL_MAX_TWO_MONTHS_WINDOW;
    } else if (!firstHigh && !secondHigh && thirdHigh) {
      fourthWindow = RENAL_THREE_TO_FOUR_WINDOW;
    }

    if (fourthWindow) {
      sequence.windows.fourth = fourthWindow;
      sequence.fourth = chooseRecordInWindow(afterThird, sequence.third.date, fourthWindow);
    }

    return sequence;
  }

  function microalbuminuriaSequenceComplies(sequence) {
    if (!sequence.first || !sequence.second) return false;
    const firstHigh = Number(sequence.first.value) >= 30;
    const secondHigh = Number(sequence.second.value) >= 30;

    if (!firstHigh) {
      if (!secondHigh) {
        if (!sequence.third) return true;
        if (Number(sequence.third.value) < 30) return true;
        return true;
      }
      if (!sequence.third) return false;
      if (Number(sequence.third.value) >= 30) return true;
      return Boolean(sequence.fourth);
    }

    if (secondHigh) return true;
    return Boolean(sequence.third);
  }

  function finalizeMicroalbuminuriaSequence(sequence, watchDate, config) {
    const firstHigh = Number(sequence.first.value) >= 30;
    const second = sequence.second;
    const third = sequence.third;
    const fourth = sequence.fourth;
    let result = null;
    let nextWindow = null;

    if (!second) {
      nextWindow = buildAlgorithmWindow(sequence.first, firstHigh ? RENAL_THREE_TO_FOUR_WINDOW : RENAL_YEAR_WINDOW);
    } else {
      const secondHigh = Number(second.value) >= 30;
      if (!third) {
        if (!firstHigh && !secondHigh) result = "SE DESCARTA ERC";
        else if (!firstHigh && secondHigh) nextWindow = buildAlgorithmWindow(second, RENAL_THREE_TO_FOUR_WINDOW);
        else if (firstHigh && secondHigh) result = "SE CONFIRMA ERC";
        else nextWindow = buildAlgorithmWindow(second, RENAL_MAX_TWO_MONTHS_WINDOW);
      } else {
        const thirdHigh = Number(third.value) >= 30;
        if (!firstHigh && secondHigh) {
          if (thirdHigh) result = "SE CONFIRMA ERC";
          else if (fourth) result = Number(fourth.value) >= 30 ? "SE CONFIRMA ERC" : "SE DESCARTA ERC";
          else nextWindow = buildAlgorithmWindow(third, RENAL_MAX_TWO_MONTHS_WINDOW);
        } else if (!firstHigh && !secondHigh) {
          if (!thirdHigh) result = "SE DESCARTA ERC";
          else if (fourth) {
            if (Number(fourth.value) >= 30) result = "SE CONFIRMA ERC";
            else nextWindow = buildAlgorithmWindow(fourth, RENAL_MAX_TWO_MONTHS_WINDOW);
          } else {
            nextWindow = buildAlgorithmWindow(third, RENAL_THREE_TO_FOUR_WINDOW);
          }
        } else {
          result = thirdHigh ? "SE CONFIRMA ERC" : "SE DESCARTA ERC";
        }
      }
    }

    return finalizeAlgorithmResult(sequence, config, watchDate, result, nextWindow);
  }

  function evaluateAlgorithmByScript(config) {
    const records = config.records
      .filter((lab) => Number.isFinite(Number(lab.value)) && lab.date)
      .sort((a, b) => compareIsoDates(a.date, b.date));

    if (!records.length) {
      return {
        label: config.label,
        result: "SIN REGISTRO",
        compliance: "no",
        severity: "critical",
        chain: [],
        gaps: [],
        nextWindow: null,
        nextMessage: "sin registro",
        summary: `Sin registros validos para ${config.label}.`,
      };
    }

    const candidates = records.map((first) => {
      const sequence = config.buildSequence(first, records);
      const evaluated = config.finalize(sequence, watchDateOrToday(config.watchDate), config);
      evaluated.compliesByChain = config.complies(sequence);
      return evaluated;
    });

    const orderedByFirstDate = [...candidates].sort((a, b) => compareIsoDates(a.firstDate || "", b.firstDate || ""));
    return orderedByFirstDate.find((candidate) => candidate.compliesByChain) || orderedByFirstDate[0];
  }

  function createAlgorithmSequence(first) {
    return {
      first,
      second: null,
      third: null,
      fourth: null,
      windows: {
        second: null,
        third: null,
        fourth: null,
      },
    };
  }

  function finalizeAlgorithmResult(sequence, config, watchDate, result, nextWindow) {
    const chain = [sequence.first, sequence.second, sequence.third, sequence.fourth].filter(Boolean);
    const gaps = [];
    for (let index = 1; index < chain.length; index += 1) {
      gaps.push({
        from: index,
        to: index + 1,
        days: daysBetween(chain[index - 1].date, chain[index].date),
      });
    }

    let finalResult = result;
    let compliance = "si";
    let severity = "ok";
    let nextMessage = "";

    if (!finalResult && nextWindow) {
      nextMessage = `${config.label}: proxima toma ${nextWindow.label} (${nextWindow.lower}-${nextWindow.upper} dias)`;
      if (compareIsoDates(watchDate, nextWindow.windowEnd) <= 0) {
        finalResult = "AUN EN VENTANA DE OPORTUNIDAD";
        compliance = "oportunidad";
        severity = compareIsoDates(watchDate, nextWindow.windowStart) >= 0 ? "warning" : "ok";
      } else {
        finalResult = "SEGUIMIENTO VENCIDO";
        compliance = "no";
        severity = "critical";
      }
    }

    if (!finalResult) finalResult = "EN SEGUIMIENTO";
    if (["SEGUIMIENTO VENCIDO", "SIN REGISTRO"].includes(finalResult)) {
      compliance = "no";
      severity = "critical";
    }

    const firstIsAbnormal = config.isAbnormal(sequence.first.value);
    const firstState = firstIsAbnormal ? config.abnormalText : config.normalText;

    return {
      label: config.label,
      result: finalResult,
      compliance,
      severity,
      chain,
      gaps,
      nextWindow,
      nextMessage,
      summary: `${config.label}: ${firstState}; resultado ${finalResult.toLowerCase()}.`,
      firstDate: sequence.first?.date || "",
      lastDate: chain[chain.length - 1]?.date || "",
      windows: sequence.windows,
      normalText: config.normalText,
      abnormalText: config.abnormalText,
    };
  }

  function evaluateThresholdAlgorithm(config) {
    const records = config.labs
      .filter((lab) => Number.isFinite(Number(lab.value)) && lab.date)
      .sort((a, b) => compareIsoDates(a.date, b.date));

    if (!records.length) {
      return {
        label: config.label,
        result: "SIN REGISTRO",
        compliance: "no",
        severity: "critical",
        chain: [],
        gaps: [],
        nextWindow: null,
        nextMessage: "sin registro",
        summary: `Sin registros validos para ${config.label}.`,
      };
    }

    const candidates = records.map((first) => {
      const firstAbnormal = config.isAbnormal(first.value);
      const secondWindow = firstAbnormal ? RENAL_THREE_TO_FOUR_WINDOW : RENAL_YEAR_WINDOW;
      const sequence = {
        first,
        firstAbnormal,
        second: null,
        secondAbnormal: null,
        third: null,
        thirdAbnormal: null,
        secondWindow,
        thirdWindow: null,
      };
      const remaining = records.filter((lab) => compareIsoDates(lab.date, first.date) > 0);
      const second = chooseRecordInWindow(remaining, first.date, secondWindow);
      if (second) {
        sequence.second = second;
        sequence.secondAbnormal = config.isAbnormal(second.value);
        if (sequence.secondAbnormal !== firstAbnormal) {
          sequence.thirdWindow = RENAL_MAX_TWO_MONTHS_WINDOW;
          const third = chooseRecordInWindow(
            remaining.filter((lab) => labKey(lab) !== labKey(second) && compareIsoDates(lab.date, second.date) > 0),
            second.date,
            RENAL_MAX_TWO_MONTHS_WINDOW,
          );
          if (third) {
            sequence.third = third;
            sequence.thirdAbnormal = config.isAbnormal(third.value);
          }
        }
      }
      return finalizeThresholdSequence(sequence, config, watchDateOrToday(config.watchDate));
    });

    candidates.sort((a, b) => {
      const dateOrder = compareIsoDates(b.lastDate || "", a.lastDate || "");
      if (dateOrder !== 0) return dateOrder;
      if (b.chain.length !== a.chain.length) return b.chain.length - a.chain.length;
      return compareIsoDates(b.firstDate || "", a.firstDate || "");
    });
    return candidates[0];
  }

  function chooseRecordInWindow(records, anchorDate, window) {
    const windowStart = addDays(anchorDate, window.lower);
    const windowEnd = addDays(anchorDate, window.upper);
    return records
      .filter((lab) => compareIsoDates(lab.date, windowStart) >= 0 && compareIsoDates(lab.date, windowEnd) <= 0)
      .sort((a, b) => compareIsoDates(a.date, b.date))[0] || null;
  }

  function finalizeThresholdSequence(sequence, config, watchDate) {
    const chain = [sequence.first, sequence.second, sequence.third].filter(Boolean);
    const gaps = [];
    if (sequence.first && sequence.second) {
      gaps.push({
        from: 1,
        to: 2,
        days: daysBetween(sequence.first.date, sequence.second.date),
      });
    }
    if (sequence.second && sequence.third) {
      gaps.push({
        from: 2,
        to: 3,
        days: daysBetween(sequence.second.date, sequence.third.date),
      });
    }

    let result = "";
    let compliance = "si";
    let severity = "ok";
    let nextWindow = null;
    let nextMessage = "";
    let summary = "";

    if (!sequence.second) {
      nextWindow = buildAlgorithmWindow(sequence.first, sequence.secondWindow);
      nextMessage = `${config.label}: proxima toma ${sequence.secondWindow.label} (${sequence.secondWindow.lower}-${sequence.secondWindow.upper} dias)`;
      if (compareIsoDates(watchDate, nextWindow.windowEnd) <= 0) {
        result = "AUN EN VENTANA DE OPORTUNIDAD";
        compliance = "oportunidad";
        severity = compareIsoDates(watchDate, nextWindow.windowStart) >= 0 ? "warning" : "ok";
      } else {
        result = "SEGUIMIENTO VENCIDO";
        compliance = "no";
        severity = "critical";
      }
    } else if (sequence.secondAbnormal === sequence.firstAbnormal) {
      result = sequence.secondAbnormal ? "SE CONFIRMA ERC" : "SE DESCARTA ERC";
      compliance = "si";
      severity = "ok";
    } else if (!sequence.third) {
      nextWindow = buildAlgorithmWindow(sequence.second, RENAL_MAX_TWO_MONTHS_WINDOW);
      nextMessage = `${config.label}: toma de desempate (${RENAL_MAX_TWO_MONTHS_WINDOW.lower}-${RENAL_MAX_TWO_MONTHS_WINDOW.upper} dias)`;
      if (compareIsoDates(watchDate, nextWindow.windowEnd) <= 0) {
        result = "AUN EN VENTANA DE OPORTUNIDAD";
        compliance = "oportunidad";
        severity = compareIsoDates(watchDate, nextWindow.windowStart) >= 0 ? "warning" : "ok";
      } else {
        result = "SEGUIMIENTO VENCIDO";
        compliance = "no";
        severity = "critical";
      }
    } else {
      result = sequence.thirdAbnormal ? "SE CONFIRMA ERC" : "SE DESCARTA ERC";
      compliance = "si";
      severity = "ok";
    }

    const firstState = sequence.firstAbnormal ? config.abnormalText : config.normalText;
    summary = `${config.label}: ${firstState}; resultado ${result.toLowerCase()}.`;

    return {
      label: config.label,
      result,
      compliance,
      severity,
      chain,
      gaps,
      nextWindow,
      nextMessage,
      summary,
      firstDate: sequence.first?.date || "",
      lastDate: chain[chain.length - 1]?.date || "",
      windows: {
        second: sequence.secondWindow,
        third: sequence.thirdWindow,
      },
      normalText: config.normalText,
      abnormalText: config.abnormalText,
    };
  }

  function buildAlgorithmWindow(anchorLab, window) {
    return {
      anchorLab,
      lower: window.lower,
      upper: window.upper,
      label: window.label,
      dueDate: addDays(anchorLab.date, window.lower),
      windowStart: addDays(anchorLab.date, window.lower),
      windowEnd: addDays(anchorLab.date, window.upper),
    };
  }

  function watchDateOrToday(value) {
    return value || todayIso();
  }

  function statusFromTarget(lab, targetDate, windowDays, watchDate, message) {
    const windowStart = addDays(targetDate, -windowDays);
    const windowEnd = addDays(targetDate, windowDays);
    const days = lab?.date ? daysBetween(lab.date, watchDate) : null;
    if (compareIsoDates(watchDate, windowEnd) > 0) {
      return {
        severity: "critical",
        message,
        days,
        dueDate: targetDate,
        windowStart,
        windowEnd,
        overdueDays: daysBetween(windowEnd, watchDate),
        daysToWindow: 0,
        remaining: 0,
        maxDays: lab?.date ? daysBetween(lab.date, targetDate) : null,
        windowDays,
        missing: false,
      };
    }
    if (compareIsoDates(watchDate, windowStart) >= 0) {
      return {
        severity: "warning",
        message,
        days,
        dueDate: targetDate,
        windowStart,
        windowEnd,
        overdueDays: 0,
        daysToWindow: 0,
        remaining: Math.max(0, daysBetween(watchDate, windowEnd)),
        maxDays: lab?.date ? daysBetween(lab.date, targetDate) : null,
        windowDays,
        missing: false,
      };
    }
    return {
      severity: "ok",
      message,
      days,
      dueDate: targetDate,
      windowStart,
      windowEnd,
      overdueDays: 0,
      daysToWindow: Math.max(0, daysBetween(watchDate, windowStart)),
      remaining: Math.max(0, daysBetween(watchDate, windowStart)),
      maxDays: lab?.date ? daysBetween(lab.date, targetDate) : null,
      windowDays,
      missing: false,
    };
  }

  function statusFromAlgorithmWindow(window, watchDate, message) {
    const days = daysBetween(window.anchorLab.date, watchDate);
    if (compareIsoDates(watchDate, window.windowEnd) > 0) {
      return {
        severity: "critical",
        message,
        days,
        dueDate: window.dueDate,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        overdueDays: daysBetween(window.windowEnd, watchDate),
        daysToWindow: 0,
        remaining: 0,
        maxDays: window.upper,
        windowDays: window.upper - window.lower,
        missing: false,
      };
    }
    if (compareIsoDates(watchDate, window.windowStart) >= 0) {
      return {
        severity: "warning",
        message,
        days,
        dueDate: window.dueDate,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        overdueDays: 0,
        daysToWindow: 0,
        remaining: Math.max(0, daysBetween(watchDate, window.windowEnd)),
        maxDays: window.upper,
        windowDays: window.upper - window.lower,
        missing: false,
      };
    }
    return {
      severity: "ok",
      message,
      days,
      dueDate: window.dueDate,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      overdueDays: 0,
      daysToWindow: Math.max(0, daysBetween(watchDate, window.windowStart)),
      remaining: Math.max(0, daysBetween(watchDate, window.windowStart)),
      maxDays: window.upper,
      windowDays: window.upper - window.lower,
      missing: false,
    };
  }

  function evaluateRenalAlgorithmTimeline(labs, watchDate) {
    const renalLabs = labs
      .filter((lab) => ["creatinine", "egfr", "albuminuria", "acr"].includes(lab.type))
      .map((lab) => lab.date)
      .filter(Boolean)
      .sort(compareIsoDates)
      .filter((date, index, array) => index === 0 || date !== array[index - 1]);

    if (!renalLabs.length) return [];

    const first = renalLabs[0];
    const last = renalLabs[renalLabs.length - 1];
    const ageFromFirst = daysBetween(first, watchDate);
    const notes = [];

    if (ageFromFirst <= 180 && renalLabs.length === 1) {
      if (ageFromFirst < 90) {
        notes.push({
          severity: "warning",
          text: `Algoritmo ERC iniciado el ${first}; segunda toma desde el dia 90.`,
          action: `Programar segunda toma renal entre ${addDays(first, 90)} y ${addDays(first, 119)}.`,
        });
      } else if (ageFromFirst <= 119) {
        notes.push({
          severity: "critical",
          text: `Algoritmo ERC en ventana de segunda toma desde ${first}.`,
          action: "Tomar segunda creatinina/TFG y albuminuria o ACR para continuidad del algoritmo.",
        });
      } else {
        notes.push({
          severity: "critical",
          text: `Segunda toma renal supero la ventana de 4 meses desde ${first}.`,
          action: "Reiniciar o documentar nueva ruta diagnostica renal segun criterio clinico.",
        });
      }
    }

    if (renalLabs.length >= 2) {
      const second = renalLabs[1];
      const gap = daysBetween(first, second);
      if (gap > 0 && gap < 90) {
        notes.push({
          severity: "warning",
          text: `Segunda toma renal a ${gap} dias; CAC exige minimo 90 dias.`,
          action: "Validar nueva toma renal desde el dia 90 si el paciente sigue en estudio.",
        });
      }
      if (gap > 119 && ageFromFirst <= 220) {
        notes.push({
          severity: "critical",
          text: `Segunda toma renal a ${gap} dias; CAC no debe superar 4 meses.`,
          action: "Revisar continuidad del algoritmo diagnostico ERC.",
        });
      }
    }

    if (daysBetween(first, last) > 180 && daysBetween(last, watchDate) <= 180) {
      notes.push({
        severity: "warning",
        text: "El algoritmo diagnostico ERC no debe superar 6 meses entre primera y cierre.",
        action: "Verificar soportes y fechas del algoritmo renal.",
      });
    }
    return notes;
  }

  function evaluateLipidProfile(latest, settings) {
    const types = ["totalChol", "hdl", "ldl", "triglycerides"];
    const missing = types.filter((type) => !latest[type]);
    if (missing.length) {
      return {
        severity: "critical",
        lab: null,
        dueDate: settings.watchDate,
        windowStart: settings.watchDate,
        windowEnd: settings.watchDate,
        days: null,
        overdueDays: null,
        daysToWindow: 0,
        remaining: 0,
        missing: true,
        message: `Completar perfil lipidico: faltan ${missing
          .map((type) => LAB_LABELS[type])
          .join(", ")}.`,
      };
    }
    const oldest = types
      .map((type) => latest[type])
      .sort((a, b) => compareIsoDates(a.date, b.date))[0];
    const status = dueStatus(oldest, settings.lipidDays, settings.dueSoonDays, settings.watchDate);
    if (status.severity === "critical") {
      return {
        ...status,
        lab: oldest,
        severity: "critical",
        message: `Perfil lipidico vencido: ${status.overdueDays} dias despues del fin de ventana.`,
      };
    }
    if (status.severity === "warning") {
      return {
        ...status,
        lab: oldest,
        severity: "warning",
        message: `Perfil lipidico en ventana de toma hasta ${status.windowEnd}.`,
      };
    }
    return { ...status, lab: oldest, severity: "ok", message: "" };
  }

  function dueStatus(lab, maxDays, dueSoonDays, watchDate) {
    const windowDays = dueSoonDays;
    if (!lab || !lab.date) {
      return {
        severity: "critical",
        message: "sin registro",
        days: null,
        dueDate: watchDate,
        windowStart: watchDate,
        windowEnd: watchDate,
        overdueDays: null,
        daysToWindow: 0,
        remaining: 0,
        maxDays,
        windowDays,
        missing: true,
      };
    }
    const days = daysBetween(lab.date, watchDate);
    const dueDate = addDays(lab.date, maxDays);
    const windowStart = addDays(dueDate, -windowDays);
    const windowEnd = addDays(dueDate, windowDays);
    if (compareIsoDates(watchDate, windowEnd) > 0) {
      return {
        severity: "critical",
        message: "vencido",
        days,
        dueDate,
        windowStart,
        windowEnd,
        overdueDays: daysBetween(windowEnd, watchDate),
        daysToWindow: 0,
        remaining: 0,
        maxDays,
        windowDays,
        missing: false,
      };
    }
    if (compareIsoDates(watchDate, windowStart) >= 0) {
      const remainingToWindowEnd = Math.max(0, daysBetween(watchDate, windowEnd));
      return {
        severity: "warning",
        message: "en ventana",
        days,
        dueDate,
        windowStart,
        windowEnd,
        overdueDays: 0,
        daysToWindow: 0,
        remaining: remainingToWindowEnd,
        maxDays,
        windowDays,
        missing: false,
      };
    }
    const daysToWindow = Math.max(0, daysBetween(watchDate, windowStart));
    return {
      severity: "ok",
      message: "vigente",
      days,
      dueDate,
      windowStart,
      windowEnd,
      overdueDays: 0,
      daysToWindow,
      remaining: daysToWindow,
      maxDays,
      windowDays,
      missing: false,
    };
  }

  function makeSchedule(label, lab, status) {
    return {
      label,
      lab,
      severity: status.severity,
      dueDate: status.dueDate,
      windowStart: status.windowStart,
      windowEnd: status.windowEnd,
      days: status.days,
      overdueDays: status.overdueDays,
      daysToWindow: status.daysToWindow,
      remaining: status.remaining,
      missing: Boolean(status.missing),
      notApplicable: Boolean(status.notApplicable),
      message: status.message,
    };
  }

  function makeNotApplicableSchedule(label) {
    return {
      label,
      lab: null,
      severity: "ok",
      dueDate: "",
      windowStart: "",
      windowEnd: "",
      days: null,
      overdueDays: null,
      daysToWindow: null,
      remaining: null,
      missing: false,
      notApplicable: true,
      message: "no aplica",
    };
  }

  function mostUrgentSchedule(schedules) {
    const severityRank = { critical: 3, warning: 2, ok: 1 };
    return [...schedules].filter((schedule) => !schedule.notApplicable).sort((a, b) => {
      if (severityRank[b.severity] !== severityRank[a.severity]) {
        return severityRank[b.severity] - severityRank[a.severity];
      }
      if (a.severity === "critical") {
        if (a.missing !== b.missing) return a.missing ? -1 : 1;
        return (b.overdueDays || 0) - (a.overdueDays || 0);
      }
      return (a.daysToWindow ?? 99999) - (b.daysToWindow ?? 99999);
    })[0];
  }

  function pushDueAction(actions, flags, flagName, status, label) {
    if (status.severity === "critical") {
      setFlag(flags, flagName, "critical");
      actions.push(
        status.days === null
          ? `Solicitar ${label}: sin registro vigente.`
          : `Solicitar ${label}: vencido hace ${status.overdueDays} dias; fin de ventana ${status.windowEnd}.`,
      );
    } else if (status.severity === "warning") {
      setFlag(flags, flagName, "warning");
      actions.push(`Citar para ${label}: ventana clinica activa hasta ${status.windowEnd}.`);
    }
  }

  function setFlag(flags, key, severity) {
    const order = { ok: 0, warning: 1, critical: 2 };
    if (order[severity] > order[flags[key]]) flags[key] = severity;
  }

  function highestSeverity(values) {
    if (values.includes("critical")) return "critical";
    if (values.includes("warning")) return "warning";
    return "ok";
  }

  function applyFilters() {
    const query = normalizeText(els.searchInput.value);
    const severity = els.severityFilter.value;
    const exam = els.examFilter.value;

    state.filtered = state.evaluated.filter((item) => {
      const patient = item.patient;
      if (!isActivePatientForManagement(patient)) return false;
      if (severity !== "all" && item.severity !== severity) return false;
      if (exam !== "all" && item.flags[exam] !== item.severity && item.flags[exam] === "ok") {
        return false;
      }
      if (exam !== "all" && item.flags[exam] === "ok") return false;
      if (!query) return true;
      const haystack = normalizeText(
        [patient.name, patient.id, patient.type, patient.ips, patient.status, patient.stage].join(
          " ",
        ),
      );
      return haystack.includes(query);
    });
    const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
  }

  function render() {
    renderMetrics();
    renderCohortAnalytics();
    renderIndicatorDashboard();
    renderRows();
  }

  function renderMetrics() {
    const totals = { critical: 0, warning: 0, ok: 0 };
    const activeItems = state.evaluated.filter((item) => isActivePatientForManagement(item.patient));
    activeItems.forEach((item) => {
      totals[item.severity] += 1;
    });
    els.metricCritical.textContent = totals.critical.toLocaleString("es-CO");
    els.metricWarning.textContent = totals.warning.toLocaleString("es-CO");
    els.metricOk.textContent = totals.ok.toLocaleString("es-CO");
    els.metricPatients.textContent = activeItems.length.toLocaleString("es-CO");
  }

  function renderCohortAnalytics() {
    if (!els.cohortPriorityChart || !els.examStatusChart || !els.renalStageChart || !els.examCoverageChart) return;
    const items = state.evaluated.filter((item) => isActivePatientForManagement(item.patient));
    const total = items.length;
    els.cohortAnalyticsSummary.textContent = total
      ? `${total.toLocaleString("es-CO")} pacientes activos`
      : "Sin datos";

    const priorityCounts = countBy(items, (item) => item.severity);
    els.cohortPriorityChart.innerHTML = renderDistributionChart(
      [
        { label: "Crítica", value: priorityCounts.critical || 0, tone: "critical" },
        { label: "Próxima", value: priorityCounts.warning || 0, tone: "warning" },
        { label: "Al día", value: priorityCounts.ok || 0, tone: "ok" },
      ],
      total,
      "pacientes",
    );

    const examDefinitions = [
      ["creatinine", "Creatinina"],
      ["albuminuria", "Microalbuminuria/ACR"],
      ["hba1c", "HbA1c"],
      ["lipids", "Perfil lipídico"],
    ];
    els.examStatusChart.innerHTML = total
      ? `<div class="stacked-chart">${examDefinitions.map(([key, label]) => {
          const counts = { critical: 0, warning: 0, ok: 0, neutral: 0 };
          items.forEach((item) => {
            const schedule = item.scheduleMap[key];
            const tone = schedule?.notApplicable ? "neutral" : schedule?.severity || "critical";
            counts[tone] += 1;
          });
          return renderStackedRow(label, counts, total);
        }).join("")}</div>${renderChartLegend([
          ["critical", "Vencido / sin registro"],
          ["warning", "En ventana"],
          ["ok", "Al día"],
          ["neutral", "No aplica"],
        ])}`
      : renderEmptyChart();

    const stageCounts = countBy(items, renalStageLabel);
    const stageEntries = Object.entries(stageCounts)
      .map(([label, value]) => ({ label, value, tone: stageTone(label) }))
      .sort((a, b) => stageOrder(a.label) - stageOrder(b.label));
    els.renalStageChart.innerHTML = renderDistributionChart(stageEntries, total, "pacientes");

    const coverageEntries = examDefinitions.map(([key, label]) => {
      const present = items.filter((item) => hasExamResult(item, key)).length;
      return { label, value: present, missing: Math.max(0, total - present), tone: "coverage" };
    });
    els.examCoverageChart.innerHTML = total
      ? `<div class="coverage-chart">${coverageEntries.map((entry) => {
          const percent = Math.round((entry.value / total) * 100);
          return `<div class="coverage-row">
            <div><strong>${escapeHtml(entry.label)}</strong><span>${percent}% · ${entry.value.toLocaleString("es-CO")} con dato</span></div>
            <div class="chart-track-html"><span class="coverage" style="width:${percent}%"></span></div>
            <small>${entry.missing.toLocaleString("es-CO")} sin dato</small>
          </div>`;
        }).join("")}</div>`
      : renderEmptyChart();
  }

  function countBy(items, selector) {
    return items.reduce((counts, item) => {
      const key = selector(item) || "Sin dato";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  }

  function renderDistributionChart(entries, total, unit) {
    if (!total) return renderEmptyChart();
    return `<div class="distribution-chart">${entries.map((entry) => {
      const percent = Math.round((entry.value / total) * 100);
      return `<div class="distribution-row">
        <div><span class="legend-dot ${escapeAttribute(entry.tone)}"></span><strong>${escapeHtml(entry.label)}</strong><span>${entry.value.toLocaleString("es-CO")} ${escapeHtml(unit)}</span></div>
        <div class="chart-track-html"><span class="${escapeAttribute(entry.tone)}" style="width:${percent}%"></span></div>
        <b>${percent}%</b>
      </div>`;
    }).join("")}</div>`;
  }

  function renderStackedRow(label, counts, total) {
    const tones = ["critical", "warning", "ok", "neutral"];
    return `<div class="stacked-row">
      <div><strong>${escapeHtml(label)}</strong><span>${(counts.critical || 0).toLocaleString("es-CO")} por gestionar</span></div>
      <div class="stacked-bar">${tones.map((tone) => {
        const value = counts[tone] || 0;
        const width = total ? (value / total) * 100 : 0;
        return `<span class="${tone}" style="flex:0 0 ${width}%" title="${escapeAttribute(`${value} ${tone}`)}"></span>`;
      }).join("")}</div>
    </div>`;
  }

  function renderChartLegend(entries) {
    return `<div class="cohort-chart-legend">${entries.map(([tone, label]) => `<span><i class="${escapeAttribute(tone)}"></i>${escapeHtml(label)}</span>`).join("")}</div>`;
  }

  function renderEmptyChart() {
    return `<div class="chart-empty">Carga una cohorte para ver esta gráfica.</div>`;
  }

  function renalStageLabel(item) {
    const raw = String(item.patient.stage || "").trim();
    const match = raw.match(/(?:estadio|^g?)\s*([1-5])\s*([ab])?/i);
    if (match) return `G${match[1]}${(match[2] || "").toLowerCase()}`;
    const value = Number(item.latest.egfr?.value);
    if (!Number.isFinite(value)) return "Sin estadio";
    if (value >= 90) return "G1";
    if (value >= 60) return "G2";
    if (value >= 45) return "G3a";
    if (value >= 30) return "G3b";
    if (value >= 15) return "G4";
    return "G5";
  }

  function stageOrder(label) {
    return { G1: 1, G2: 2, G3a: 3, G3: 3.5, G3b: 4, G4: 5, G5: 6, "Sin estadio": 7 }[label] || 8;
  }

  function stageTone(label) {
    if (["G4", "G5"].includes(label)) return "critical";
    if (["G3", "G3a", "G3b"].includes(label)) return "warning";
    if (["G1", "G2"].includes(label)) return "ok";
    return "neutral";
  }

  function hasExamResult(item, key) {
    if (key === "albuminuria") return Boolean(newestOf(item.latest.albuminuria, item.latest.acr));
    if (key === "lipids") {
      return Boolean(newestOf(item.latest.totalChol, item.latest.hdl, item.latest.ldl, item.latest.triglycerides));
    }
    return Boolean(item.latest[key]);
  }

  function renderIndicatorDashboard() {
    if (!els.indicatorCards || !els.indicatorBarChart || !els.indicatorStatusChart) return;
    const indicators = buildContractIndicators();
    const statusCounts = indicators.reduce(
      (totals, indicator) => {
        totals[indicator.status] += 1;
        return totals;
      },
      { ok: 0, critical: 0, neutral: 0 },
    );
    const validIndicators = indicators.filter((indicator) => indicator.denominator > 0);
    const average =
      validIndicators.length > 0
        ? validIndicators.reduce((sum, indicator) => sum + indicator.value, 0) / validIndicators.length
        : 0;

    els.indicatorSummaryText.textContent = validIndicators.length
      ? `${formatPercent(average)} promedio`
      : "Sin datos";
    els.indicatorCards.innerHTML = indicators.map(renderIndicatorCard).join("");
    els.indicatorBarChart.innerHTML = renderIndicatorBarChart(indicators);
    els.indicatorStatusChart.innerHTML = renderIndicatorStatusChart(statusCounts, indicators.length);
  }

  function buildContractIndicators(settings = getSettings(), evaluatedItems = state.evaluated) {
    const watchDate = settings.watchDate;
    const activeDmItems = evaluatedItems.filter((item) => isActivePatientForManagement(item.patient));
    const bases = {
      creatinineAlgorithm: activeDmItems.filter((item) => !isExcludedRenalAlgorithmIndicator(item.patient)),
      microalbuminuriaAlgorithm: activeDmItems.filter((item) => !isExcludedRenalAlgorithmIndicator(item.patient)),
      ldlGoal: activeDmItems.filter((item) => !hasLessThanThreeMonthsInRoute(item.patient, watchDate)),
      bpControl: activeDmItems.filter((item) => !hasLessThanThreeMonthsInProgram(item.patient, watchDate) && !item.patient.notEligibleBp),
      hba1cControl: activeDmItems.filter(
        (item) =>
          !hasLessThanThreeMonthsInProgram(item.patient, watchDate) &&
          !item.patient.notEligibleHba1c &&
          !item.patient.gestationalDiabetes,
      ),
      renalFunctionLoss: activeDmItems,
    };
    const counters = {
      creatinineAlgorithm: bases.creatinineAlgorithm.filter((item) =>
        algorithmCountsForIndicator(item.algorithms.creatinine),
      ).length,
      microalbuminuriaAlgorithm: bases.microalbuminuriaAlgorithm.filter((item) =>
        algorithmCountsForIndicator(item.algorithms.albuminuria),
      ).length,
      ldlGoal: bases.ldlGoal.filter((item) =>
        latestWithinDays(item.latest.ldl, watchDate, 365) && Number(item.latest.ldl.value) <= 100,
      ).length,
      bpControl: bases.bpControl.filter((item) => hasControlledBloodPressure(item, watchDate)).length,
      hba1cControl: bases.hba1cControl.filter((item) =>
        latestWithinDays(item.latest.hba1c, watchDate, 183) && Number(item.latest.hba1c.value) < 7,
      ).length,
      renalFunctionLoss: bases.renalFunctionLoss.filter((item) => hasStableAnnualTfg(item, watchDate)).length,
    };

    return CONTRACT_INDICATORS.map((definition) => {
      if (hasExplicitIndicatorData(activeDmItems, definition.id)) {
        return buildApplyBasedIndicatorResult(definition, activeDmItems, watchDate);
      }
      return buildIndicatorResult(
        definition,
        counters[definition.id] || 0,
        bases[definition.id]?.length || 0,
        activeDmItems.length - (bases[definition.id]?.length || 0),
      );
    });
  }

  function isActivePatientForManagement(patient) {
    if (!patient) return false;
    if (patient.activeInCohort === false) return false;
    return !patient.inactive;
  }

  function hasExplicitIndicatorData(items, indicatorId) {
    return items.some((item) => item.patient.indicators?.[indicatorId]?.hasExplicit);
  }

  function buildApplyBasedIndicatorResult(definition, items, watchDate) {
    const reasonCounts = new Map();
    const denominatorItems = items.filter((item) =>
      explicitIndicatorApplies(item.patient, definition.id, reasonCounts),
    );
    const numerator = countComputedIndicator(definition.id, denominatorItems, watchDate);
    return buildIndicatorResult(
      definition,
      numerator,
      denominatorItems.length,
      items.length - denominatorItems.length,
      reasonCountsToList(reasonCounts),
      "datos",
    );
  }

  function countComputedIndicator(indicatorId, items, watchDate) {
    switch (indicatorId) {
      case "creatinineAlgorithm":
        return items.filter((item) => {
          const status = item.patient.indicators?.creatinineAlgorithm;
          if (status?.hasExplicit && status.reason) return algorithmOutcomeCountsFromCohort(status);
          return algorithmCountsForIndicator(item.algorithms.creatinine);
        }).length;
      case "microalbuminuriaAlgorithm":
        return items.filter((item) => {
          const status = item.patient.indicators?.microalbuminuriaAlgorithm;
          if (status?.hasExplicit && status.reason) return algorithmOutcomeCountsFromCohort(status);
          return algorithmCountsForIndicator(item.algorithms.albuminuria);
        }).length;
      case "ldlGoal":
        return items.filter((item) => {
          const status = item.patient.indicators?.ldlGoal;
          if (hasStructuredIndicatorValue(status, "value")) return cohortLdlInGoal(status, watchDate);
          return (
            latestWithinDays(item.latest.ldl, watchDate, 365) &&
            Number(item.latest.ldl.value) >= 15 &&
            Number(item.latest.ldl.value) <= 100
          );
        }).length;
      case "bpControl":
        return items.filter((item) => {
          const status = item.patient.indicators?.bpControl;
          if (hasStructuredIndicatorValue(status, "systolic") || hasStructuredIndicatorValue(status, "diastolic")) {
            return cohortBloodPressureInGoal(status, watchDate);
          }
          return hasControlledBloodPressure(item, watchDate);
        }).length;
      case "hba1cControl":
        return items.filter((item) => {
          const status = item.patient.indicators?.hba1cControl;
          if (hasStructuredIndicatorValue(status, "value")) return cohortHba1cInGoal(status, watchDate);
          return (
            latestWithinDays(item.latest.hba1c, watchDate, 190) &&
            Number(item.latest.hba1c.value) >= 4 &&
            Number(item.latest.hba1c.value) < 7
          );
        }).length;
      case "renalFunctionLoss":
        return items.filter((item) => {
          const status = item.patient.indicators?.renalFunctionLoss;
          if (status?.hasExplicit) return cohortRenalFunctionLossInGoal(status);
          return hasStableAnnualTfg(item, watchDate);
        }).length;
      default:
        return 0;
    }
  }

  function hasStructuredIndicatorValue(status, key) {
    return status?.data?.[key] !== null && status?.data?.[key] !== undefined && status?.data?.[key] !== "";
  }

  function algorithmOutcomeCountsFromCohort(status) {
    if (!status?.hasExplicit) return false;
    const reason = normalizeText(status.reason || status.complianceRaw);
    return (
      reason.includes("se descarta erc") ||
      reason.includes("se confirma erc") ||
      reason.includes("ventana de oportunidad")
    );
  }

  function cohortLdlInGoal(status, watchDate) {
    const value = Number(status?.data?.value);
    return (
      Number.isFinite(value) &&
      value >= 15 &&
      value <= 100 &&
      isWithinContractLookback(status.data.date, watchDate, 365)
    );
  }

  function cohortBloodPressureInGoal(status, watchDate) {
    const systolic = Number(status?.data?.systolic);
    const diastolic = Number(status?.data?.diastolic);
    return (
      Number.isFinite(systolic) &&
      Number.isFinite(diastolic) &&
      systolic > 90 &&
      systolic < 140 &&
      diastolic > 60 &&
      diastolic < 90 &&
      isWithinContractSemester(status.data.date, watchDate)
    );
  }

  function cohortHba1cInGoal(status, watchDate) {
    const value = Number(status?.data?.value);
    return (
      Number.isFinite(value) &&
      value >= 4 &&
      value < 7 &&
      isWithinContractSemester(status.data.date, watchDate)
    );
  }

  function cohortRenalFunctionLossInGoal(status) {
    if (!status?.hasExplicit) return false;
    const reason = normalizeText(status.reason);
    if (!reason) return true;
    return false;
  }

  function cohortRenalFunctionLossInGoalFromValues(status) {
    const variation = Number(status.data?.variation);
    if (Number.isFinite(variation)) return variation <= 5;
    const initial = Number(status.data?.initialTfg);
    const current = Number(status.data?.currentTfg);
    return Number.isFinite(initial) && Number.isFinite(current) && initial - current <= 5;
  }

  function isWithinContractSemester(dateIso, watchDate) {
    if (!dateIso || compareIsoDates(dateIso, watchDate) > 0) return false;
    return compareIsoDates(dateIso, contractSemesterStart(watchDate)) >= 0;
  }

  function contractSemesterStart(watchDate) {
    const iso = parseDateValue(watchDate) || parseDateValue(todayIso());
    const date = new Date(`${iso}T00:00:00Z`);
    const year = date.getUTCFullYear();
    const monthIndex = date.getUTCMonth();
    const start = new Date(Date.UTC(year, monthIndex - 6, 1));
    return start.toISOString().slice(0, 10);
  }

  function isWithinContractLookback(dateIso, watchDate, maxDays) {
    if (!dateIso || compareIsoDates(dateIso, watchDate) > 0) return false;
    const age = daysBetween(dateIso, watchDate);
    return age >= 0 && age <= maxDays;
  }

  function explicitIndicatorApplies(patient, indicatorId, reasonCounts) {
    const global = patient.indicators?.global;
    if (global?.hasExplicit && global.applies === false) {
      addReasonCount(reasonCounts, globalExclusionReason(global));
      return false;
    }
    const status = patient.indicators?.[indicatorId];
    if (!status?.hasExplicit) {
      addReasonCount(reasonCounts, "Sin dato de aplicabilidad");
      return false;
    }
    if (status.applies !== true) {
      addReasonCount(reasonCounts, status.applyRaw || status.reason || "No aplica indicador");
      return false;
    }
    return true;
  }

  function addReasonCount(reasonCounts, reason) {
    const key = stringify(reason) || "No aplica indicador";
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }

  function globalExclusionReason(global) {
    const raw = stringify(global?.applyRaw);
    const normalized = normalizeText(raw);
    if (normalized === "no" || normalized === "n") return "No aplica indicadores";
    return global?.reason || raw || "No aplica indicadores";
  }

  function reasonCountsToList(reasonCounts) {
    return [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "es"));
  }

  function buildIndicatorResult(
    definition,
    numerator,
    denominator,
    excluded = 0,
    exclusionReasons = [],
    source = "calculado",
  ) {
    const value = denominator > 0 ? numerator / denominator : 0;
    const status = denominator <= 0 ? "neutral" : value >= definition.goal ? "ok" : "critical";
    return {
      ...definition,
      numerator,
      denominator,
      excluded,
      exclusionReasons,
      source,
      value,
      status,
      gap: value - definition.goal,
    };
  }

  function isExcludedRenalAlgorithmIndicator(patient) {
    return patient.gestationalDiabetes || isRenalStageThreeToFive(patient);
  }

  function isRenalStageThreeToFive(patient) {
    const stage = Number(patient.stageNumber);
    return Number.isFinite(stage) && stage >= 3 && stage <= 5;
  }

  function hasLessThanThreeMonthsInRoute(patient, watchDate) {
    return isLessThanDays(patient.routeEntryDate || patient.programEntryDate, watchDate, 90);
  }

  function hasLessThanThreeMonthsInProgram(patient, watchDate) {
    return isLessThanDays(patient.programEntryDate, watchDate, 90);
  }

  function isLessThanDays(startDate, watchDate, days) {
    if (!startDate) return false;
    if (compareIsoDates(startDate, watchDate) > 0) return true;
    const elapsed = daysBetween(startDate, watchDate);
    return elapsed >= 0 && elapsed < days;
  }

  function algorithmCountsForIndicator(algorithm) {
    return algorithm?.compliance === "si" || algorithm?.compliance === "oportunidad";
  }

  function latestWithinDays(lab, watchDate, maxDays) {
    if (!lab?.date || !Number.isFinite(Number(lab.value))) return false;
    if (compareIsoDates(lab.date, watchDate) > 0) return false;
    const age = daysBetween(lab.date, watchDate);
    return age >= 0 && age <= maxDays;
  }

  function hasControlledBloodPressure(item, watchDate) {
    const pair = latestBloodPressurePair(item.labs, watchDate);
    if (!pair) return false;
    return daysBetween(pair.date, watchDate) <= 183 && pair.systolic < 140 && pair.diastolic < 90;
  }

  function latestBloodPressurePair(labs, watchDate) {
    const systolic = labs
      .filter((lab) => lab.type === "systolicBp" && compareIsoDates(lab.date, watchDate) <= 0)
      .sort((a, b) => compareIsoDates(b.date, a.date));
    const diastolic = labs
      .filter((lab) => lab.type === "diastolicBp" && compareIsoDates(lab.date, watchDate) <= 0)
      .sort((a, b) => compareIsoDates(b.date, a.date));
    for (const sys of systolic) {
      const dia =
        diastolic.find((candidate) => candidate.date === sys.date) ||
        diastolic.find((candidate) => Math.abs(daysBetween(candidate.date, sys.date)) <= 1);
      if (!dia) continue;
      return {
        systolic: Number(sys.value),
        diastolic: Number(dia.value),
        date: compareIsoDates(sys.date, dia.date) >= 0 ? sys.date : dia.date,
      };
    }
    return null;
  }

  function hasStableAnnualTfg(item, watchDate) {
    const tfgRecords = buildCreatinineEgfrLabs(item.patient, item.labs, watchDate)
      .filter((lab) => compareIsoDates(lab.date, watchDate) <= 0)
      .sort((a, b) => compareIsoDates(b.date, a.date));
    const latest = tfgRecords[0];
    if (!latest) return false;
    const previous = tfgRecords
      .filter((lab) => labKey(lab) !== labKey(latest))
      .map((lab) => ({ lab, gap: daysBetween(lab.date, latest.date) }))
      .filter((entry) => entry.gap >= 330 && entry.gap <= 389)
      .sort((a, b) => Math.abs(a.gap - 360) - Math.abs(b.gap - 360))[0]?.lab;
    if (!previous) return false;
    const loss = Number(previous.value) - Number(latest.value);
    return Number.isFinite(loss) && loss <= 5;
  }

  function renderIndicatorCard(indicator) {
    const badgeLabel =
      indicator.status === "neutral" ? "Sin datos" : indicator.status === "ok" ? "En meta" : "Bajo meta";
    const reasonSummary = formatExclusionReasonSummary(indicator.exclusionReasons);
    return `
      <article class="indicator-card ${indicator.status}">
        <div>
          <span class="indicator-source">${escapeHtml(indicator.sheet)}</span>
          <h3>${escapeHtml(indicator.shortName)}</h3>
        </div>
        <strong>${escapeHtml(formatPercent(indicator.value))}</strong>
        <p>${escapeHtml(indicator.numerator.toLocaleString("es-CO"))} / ${escapeHtml(indicator.denominator.toLocaleString("es-CO"))}</p>
        ${reasonSummary ? `<small class="indicator-reasons">No aplica: ${escapeHtml(reasonSummary)}</small>` : ""}
        <footer>
          <span>Meta ${escapeHtml(formatPercent(indicator.goal))} · Excl. ${escapeHtml(indicator.excluded.toLocaleString("es-CO"))}</span>
          <span class="badge ${indicator.status}">${badgeLabel}</span>
        </footer>
      </article>`;
  }

  function formatExclusionReasonSummary(reasons = []) {
    return reasons
      .slice(0, 2)
      .map((entry) => `${entry.reason} (${entry.count.toLocaleString("es-CO")})`)
      .join(", ");
  }

  function renderIndicatorBarChart(indicators) {
    if (!indicators.length) return `<div class="chart-empty">Sin indicadores</div>`;
    const width = 860;
    const rowHeight = 54;
    const labelWidth = 220;
    const chartX = labelWidth + 18;
    const chartWidth = 420;
    const valueX = chartX + chartWidth + 18;
    const height = indicators.length * rowHeight + 30;
    const rows = indicators
      .map((indicator, index) => {
        const y = 20 + index * rowHeight;
        const barWidth = Math.max(0, Math.min(chartWidth, indicator.value * chartWidth));
        const goalX = chartX + Math.max(0, Math.min(chartWidth, indicator.goal * chartWidth));
        return `
          <g>
            <text class="chart-label" x="0" y="${y + 17}">${escapeHtml(indicator.shortName)}</text>
            <rect class="chart-track" x="${chartX}" y="${y}" width="${chartWidth}" height="18" rx="5"></rect>
            <rect class="chart-bar ${indicator.status}" x="${chartX}" y="${y}" width="${barWidth}" height="18" rx="5"></rect>
            <line class="chart-goal" x1="${goalX}" x2="${goalX}" y1="${y - 4}" y2="${y + 24}"></line>
            <text class="chart-value" x="${valueX}" y="${y + 17}">${escapeHtml(formatPercent(indicator.value))}</text>
            <text class="chart-meta" x="${chartX}" y="${y + 37}">Meta ${escapeHtml(formatPercent(indicator.goal))}</text>
          </g>`;
      })
      .join("");
    return `<svg class="indicator-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Resultado de indicadores frente a la meta">${rows}</svg>`;
  }

  function renderIndicatorStatusChart(statusCounts, total) {
    if (!total) return `<div class="chart-empty">Sin datos</div>`;
    const okWidth = (statusCounts.ok / total) * 100;
    const criticalWidth = (statusCounts.critical / total) * 100;
    const neutralWidth = Math.max(0, 100 - okWidth - criticalWidth);
    return `
      <div class="status-stack" aria-label="Semaforo de indicadores">
        <span class="ok" style="width:${okWidth}%"></span>
        <span class="critical" style="width:${criticalWidth}%"></span>
        <span class="neutral" style="width:${neutralWidth}%"></span>
      </div>
      <div class="status-legend">
        <span><i class="ok"></i> En meta <strong>${statusCounts.ok}</strong></span>
        <span><i class="critical"></i> Bajo meta <strong>${statusCounts.critical}</strong></span>
        <span><i class="neutral"></i> Sin datos <strong>${statusCounts.neutral}</strong></span>
      </div>`;
  }

  function renderRows() {
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = state.filtered.slice(start, start + PAGE_SIZE);
    els.patientRows.innerHTML = pageRows.map(renderPatientRow).join("");
    els.emptyState.classList.toggle("show", !state.filtered.length);

    const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    els.pageInfo.textContent = `Pagina ${state.page} de ${pages} - ${state.filtered.length.toLocaleString(
      "es-CO",
    )} registros`;
    els.prevPage.disabled = state.page <= 1;
    els.nextPage.disabled = state.page >= pages;
  }

  function renderPatientRow(item) {
    const patient = item.patient;
    const latest = item.latest;
    const inactive = patient.inactive ? `<span class="subtle">${escapeHtml(patient.status)}</span>` : "";
    return `
      <tr>
        <td>${severityBadge(item.severity)}</td>
        <td>${escapeHtml(patient.type || "Sin dato")}</td>
        <td>${escapeHtml(patient.id || "Sin dato")}</td>
        <td>
          <button class="patient-link" type="button" data-patient-id="${escapeAttribute(patient.id)}">${escapeHtml(patient.name)}</button>
          <span class="subtle">${escapeHtml(patient.ips || "Sin IPS")}</span>
          ${inactive}
        </td>
        <td class="tfg-cell">${formatTfgValueCell(latest.egfr)}</td>
        <td class="tfg-cell">${formatTfgDateCell(latest.egfr)}</td>
        <td>${escapeHtml(patient.stage || "Sin dato")}</td>
        ${renderLabManagementCells("creatinine", item.scheduleMap.creatinine, patient, item.algorithms.creatinine)}
        ${renderLabManagementCells("hba1c", item.scheduleMap.hba1c, patient)}
        ${renderLabManagementCells("albuminuria", item.scheduleMap.albuminuria, patient, item.algorithms.albuminuria)}
        ${renderLabManagementCells("lipids", item.scheduleMap.lipids, patient)}
        <td class="exam-cell">${formatLabCell(latest.creatinine, item.flags.renal)}</td>
        <td class="exam-cell">${formatLabCell(newestOf(latest.albuminuria, latest.acr), item.flags.renal)}</td>
        <td class="exam-cell">${formatLabCell(latest.hba1c, item.flags.hba1c)}</td>
        <td class="exam-cell">${formatLipidCell(latest, item.flags.lipids)}</td>
        <td>
          <div class="actions-list">
            ${item.actions.slice(0, 3).map((action) => `<span>${escapeHtml(action)}</span>`).join("")}
            <div class="row-actions">
              <button type="button" data-patient-id="${escapeAttribute(patient.id)}">Detalle</button>
              <button type="button" data-task-patient-id="${escapeAttribute(patient.id)}" data-task-patient-name="${escapeAttribute(patient.name)}">Crear tarea</button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function severityBadge(severity) {
    const label = severity === "critical" ? "Critica" : severity === "warning" ? "Proxima" : "Al dia";
    return `<span class="badge ${severity}">${label}</span>`;
  }

  function formatTfgCell(lab) {
    if (!lab) return `<span class="badge critical">Sin TFG</span>`;
    return `
      <strong>${escapeHtml(formatValue(lab.value))}</strong>
      <span class="subtle">${escapeHtml(formatDate(lab.date))}</span>`;
  }

  function formatTfgValueCell(lab) {
    if (!lab) return `<span class="badge critical">Sin TFG</span>`;
    return `<strong>${escapeHtml(formatValue(lab.value))}</strong>`;
  }

  function formatTfgDateCell(lab) {
    if (!lab?.date) return `<span class="muted-dash">Sin fecha</span>`;
    return `<strong>${escapeHtml(formatDate(lab.date))}</strong>`;
  }

  function formatNextExamCell(schedule) {
    if (!schedule) return `<span class="badge critical">Sin plan</span>`;
    return `
      <strong>${escapeHtml(schedule.label)}</strong>
      <span class="badge ${schedule.severity}">${escapeHtml(scheduleLabel(schedule))}</span>`;
  }

  function renderScheduleCells(schedule) {
    return `
      <td class="alarm-cell">${formatScheduleAlarmCell(schedule)}</td>
      <td class="due-cell">${formatDueDateCell(schedule)}</td>
      <td class="days-cell">${formatOverdueDaysCell(schedule)}</td>
      <td class="days-cell">${formatRemainingDaysCell(schedule)}</td>`;
  }

  function renderLabManagementCells(labKeyName, schedule, patient, algorithm = null) {
    return `
      <td class="due-cell">${formatDueDateCell(schedule)}</td>
      <td class="alarm-cell">${formatScheduleAlarmCell(schedule)}</td>
      ${algorithm ? `<td class="algorithm-cell">${formatAlgorithmComplianceCell(algorithm)}</td>` : ""}
      <td class="days-cell">${formatOverdueDaysCell(schedule)}</td>
      <td class="days-cell">${formatRemainingDaysCell(schedule)}</td>
      <td class="managed-cell">${formatManagedCheckbox(patient, labKeyName, schedule)}</td>`;
  }

  function formatAlgorithmComplianceCell(algorithm) {
    const badgeClass =
      algorithm.compliance === "no"
        ? "critical"
        : algorithm.compliance === "oportunidad"
          ? "warning"
          : "ok";
    const label =
      algorithm.compliance === "no"
        ? "No cumple"
        : algorithm.compliance === "oportunidad"
          ? "En oportunidad"
          : "Cumple";
    return `
      <span class="badge ${badgeClass}">${label}</span>
      <span class="subtle">${escapeHtml(algorithm.result || "")}</span>`;
  }

  function formatManagedCheckbox(patient, labKeyName, schedule) {
    const key = managedKey(patient, labKeyName);
    const checked = state.managed[key] ? " checked" : "";
    return `
      <label class="managed-check">
        <input type="checkbox" data-managed-key="${escapeAttribute(key)}" data-patient-id="${escapeAttribute(patient.id)}" data-lab-key="${escapeAttribute(labKeyName)}" data-due-date="${escapeAttribute(schedule?.dueDate || "")}"${checked} />
        <span>Gestionado</span>
      </label>`;
  }

  function managedKey(patient, labKeyName) {
    return `${patient.type || ""}|${patient.id}|${labKeyName}`;
  }

  function formatScheduleAlarmCell(schedule) {
    if (!schedule) return `<span class="badge critical">Sin plan</span>`;
    const badgeClass = schedule.notApplicable ? "neutral" : schedule.severity;
    return `
      <span class="badge ${badgeClass}">${escapeHtml(scheduleLabel(schedule))}</span>
      <span class="subtle">${escapeHtml(schedule.message || "")}</span>`;
  }

  function formatDueDateCell(schedule) {
    if (!schedule) return "Sin dato";
    if (schedule.notApplicable) return `<span class="muted-dash">No aplica</span>`;
    const label = schedule.missing ? "Tomar ahora" : formatDate(schedule.dueDate);
    return `
      <strong>${escapeHtml(label)}</strong>
      <span class="subtle">${escapeHtml(schedule.missing ? "Sin registro previo" : `Ventana ${schedule.windowStart} a ${schedule.windowEnd}`)}</span>`;
  }

  function formatOverdueDaysCell(schedule) {
    if (!schedule) return "Sin dato";
    if (schedule.notApplicable) return `<span class="muted-dash">NA</span>`;
    if (schedule.missing) return `<strong class="danger-text">Sin registro</strong>`;
    if ((schedule.overdueDays || 0) > 0) {
      return `<strong class="danger-text">${escapeHtml(String(schedule.overdueDays))}</strong>`;
    }
    return `<span class="muted-dash">0</span>`;
  }

  function formatRemainingDaysCell(schedule) {
    if (!schedule) return "Sin dato";
    if (schedule.notApplicable) return `<span class="muted-dash">NA</span>`;
    if (schedule.missing) return `<span class="muted-dash">0</span>`;
    if ((schedule.overdueDays || 0) > 0) return `<span class="muted-dash">0</span>`;
    return `<strong class="${schedule.severity === "warning" ? "warning-text" : "ok-text"}">${escapeHtml(String(schedule.daysToWindow || 0))}</strong>`;
  }

  function scheduleLabel(schedule) {
    if (schedule.notApplicable) return "No aplica";
    if (schedule.missing) return "Sin registro";
    if (schedule.severity === "critical") return "Vencido";
    if (schedule.severity === "warning") return "En ventana";
    return "Aun no citar";
  }

  function formatLabCell(lab, severity) {
    if (!lab) return `<span class="badge critical">Sin dato</span>`;
    return `
      <strong>${escapeHtml(formatValue(lab.value))}</strong>
      <span class="subtle">${escapeHtml(formatDate(lab.date))}</span>
      <span class="badge ${severity === "ok" ? "ok" : severity}">${escapeHtml(LAB_LABELS[lab.type])}</span>`;
  }

  function formatLipidCell(latest, severity) {
    const parts = ["totalChol", "hdl", "ldl", "triglycerides"]
      .map((type) => latest[type])
      .filter(Boolean);
    if (!parts.length) return `<span class="badge critical">Sin dato</span>`;
    const newest = parts.sort((a, b) => compareIsoDates(b.date, a.date))[0];
    const present = parts.map((lab) => LAB_LABELS[lab.type]).join(", ");
    return `
      <strong>${escapeHtml(formatDate(newest.date))}</strong>
      <span class="subtle">${escapeHtml(present)}</span>
      <span class="badge ${severity === "ok" ? "ok" : severity}">Perfil</span>`;
  }

  function showPatientDetail(patientId) {
    const item = state.evaluated.find((candidate) => candidate.patient.id === patientId);
    if (!item) return;
    const patient = item.patient;
    els.detailDoc.textContent = [patient.type, patient.id].filter(Boolean).join(" ");
    els.detailName.textContent = patient.name;
    const sortedLabs = [...item.labs].sort((a, b) => compareIsoDates(b.date, a.date)).slice(0, 30);
    els.detailContent.innerHTML = `
      <article class="detail-panel">
        <h3>Datos</h3>
        <ul>
          <li>IPS: ${escapeHtml(patient.ips || "Sin dato")}</li>
          <li>Edad: ${escapeHtml(patient.age || "Sin dato")}</li>
          <li>Sexo: ${escapeHtml(patient.sex || "Sin dato")}</li>
          <li>Peso: ${patient.weight ? `${escapeHtml(patient.weight)} kg` : "Sin dato"}</li>
          <li>Ingreso programa: ${escapeHtml(patient.programEntryDate || "Sin dato")}</li>
          <li>Ingreso ruta: ${escapeHtml(patient.routeEntryDate || patient.programEntryDate || "Sin dato")}</li>
          <li>ERC: ${patient.erc ? "Si" : "No"} - ${escapeHtml(patient.stage || "Sin estadio")}</li>
          <li>DM: ${patient.dm ? "Si" : "No"} | HTA: ${patient.hta ? "Si" : "No"}</li>
          <li>DM gestacional: ${patient.gestationalDiabetes ? "Si" : "No"}</li>
          <li>No apto PA: ${patient.notEligibleBp ? "Si" : "No"} | No apto HbA1c: ${patient.notEligibleHba1c ? "Si" : "No"}</li>
        </ul>
      </article>
      <article class="detail-panel">
        <h3>Alarmas</h3>
        <ul>${item.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>
      </article>
      <article class="detail-panel">
        <h3>Proximas tomas</h3>
        <ul>${item.schedules.map(renderScheduleDetail).join("")}</ul>
      </article>
      <article class="detail-panel">
        <h3>Cumplimiento algoritmo renal</h3>
        ${renderAlgorithmDetail(item.algorithms.creatinine)}
        ${renderAlgorithmDetail(item.algorithms.albuminuria)}
      </article>
      <article class="detail-panel">
        <h3>Reglas CAC aplicadas</h3>
        <ul>
          <li>Algoritmo diagnostico ERC: maximo 6 meses.</li>
          <li>Seguimiento anual: ventana valida ${RENAL_YEAR_WINDOW.lower}-${RENAL_YEAR_WINDOW.upper} dias.</li>
          <li>TFG &lt;60: segunda creatinina/TFG valida entre ${RENAL_THREE_TO_FOUR_WINDOW.lower}-${RENAL_THREE_TO_FOUR_WINDOW.upper} dias.</li>
          <li>Creatinina/TFG: si inicia &gt;=60 y luego cae &lt;60, tercera toma ${RENAL_THREE_TO_FOUR_WINDOW.lower}-${RENAL_THREE_TO_FOUR_WINDOW.upper} dias; si inicia &lt;60 y luego sube &gt;=60, tercera toma ${RENAL_MAX_TWO_MONTHS_WINDOW.lower}-${RENAL_MAX_TWO_MONTHS_WINDOW.upper} dias.</li>
          <li>Creatinina/TFG adicional: aplica en patrones &gt;=60, &lt;60, &gt;=60 a ${RENAL_MAX_TWO_MONTHS_WINDOW.lower}-${RENAL_MAX_TWO_MONTHS_WINDOW.upper} dias; o &gt;=60, &gt;=60, &lt;60 a ${RENAL_THREE_TO_FOUR_WINDOW.lower}-${RENAL_THREE_TO_FOUR_WINDOW.upper} dias.</li>
          <li>Microalbuminuria/ACR: &lt;30 controla anual; &gt;=30 controla a ${RENAL_THREE_TO_FOUR_WINDOW.lower}-${RENAL_THREE_TO_FOUR_WINDOW.upper} dias; las adicionales usan ${RENAL_MAX_TWO_MONTHS_WINDOW.lower}-${RENAL_MAX_TWO_MONTHS_WINDOW.upper} o ${RENAL_THREE_TO_FOUR_WINDOW.lower}-${RENAL_THREE_TO_FOUR_WINDOW.upper} dias segun la secuencia.</li>
          <li>HbA1c DM: maximo ${escapeHtml(String(getSettings().hba1cDays))} dias.</li>
          <li>HbA1c y perfil lipidico conservan ventana operativa de ${escapeHtml(String(getSettings().dueSoonDays))} dias antes y ${escapeHtml(String(getSettings().dueSoonDays))} dias despues de la fecha objetivo.</li>
        </ul>
      </article>
      <article class="detail-panel">
        <h3>Ultimos paraclinicos</h3>
        <ul>${
          sortedLabs.length
            ? sortedLabs
                .map(
                  (lab) =>
                    `<li>${escapeHtml(formatDate(lab.date))} - ${escapeHtml(
                      LAB_LABELS[lab.type] || lab.type,
                    )}: ${escapeHtml(formatValue(lab.value))}${lab.source ? ` | fuente: ${escapeHtml(lab.source)}` : ""}</li>`,
                )
                .join("")
            : "<li>Sin paraclinicos registrados.</li>"
        }</ul>
      </article>
    `;
    els.patientDialog.showModal();
  }

  function renderScheduleDetail(schedule) {
    if (schedule.notApplicable) {
      return `<li>${escapeHtml(schedule.label)}: no aplica para este paciente.</li>`;
    }
    const due = schedule.missing ? "Tomar ahora" : formatDate(schedule.dueDate);
    const windowText = schedule.missing ? "sin ventana previa" : `ventana ${schedule.windowStart} a ${schedule.windowEnd}`;
    const overdue = schedule.missing ? "sin registro" : `${schedule.overdueDays || 0} dias vencido`;
    const remaining = schedule.missing ? "0 dias faltan" : `${schedule.daysToWindow || 0} dias faltan para ventana`;
    return `<li>${escapeHtml(schedule.label)}: ${escapeHtml(scheduleLabel(schedule))}, objetivo ${escapeHtml(due)}, ${escapeHtml(windowText)}, ${escapeHtml(overdue)}, ${escapeHtml(remaining)}.</li>`;
  }

  function renderAlgorithmDetail(algorithm) {
    if (!algorithm) return "";
    const rows = algorithm.chain.length
      ? algorithm.chain
          .map((lab, index) => {
            const gap = index === 0 ? "" : `; diferencia vs toma ${index}: ${algorithm.gaps[index - 1]?.days ?? "NA"} dias`;
            return `<li>Toma ${index + 1}: ${escapeHtml(formatDate(lab.date))}, valor ${escapeHtml(formatValue(lab.value))}${escapeHtml(gap)}</li>`;
          })
          .join("")
      : "<li>Sin tomas validas.</li>";
    const next = algorithm.nextWindow
      ? `<li>Proxima ventana: ${algorithm.nextWindow.windowStart} a ${algorithm.nextWindow.windowEnd} (${algorithm.nextWindow.lower}-${algorithm.nextWindow.upper} dias).</li>`
      : "";
    return `
      <div class="algorithm-detail">
        <strong>${escapeHtml(algorithm.label)}: ${escapeHtml(algorithm.result)}</strong>
        <span>${formatAlgorithmComplianceCell(algorithm)}</span>
        <ul>
          ${rows}
          ${next}
        </ul>
      </div>`;
  }

  async function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("patients")) {
          db.createObjectStore("patients", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("labs")) {
          const labStore = db.createObjectStore("labs", {
            keyPath: "dbId",
            autoIncrement: true,
          });
          labStore.createIndex("patientId", "patientId", { unique: false });
          labStore.createIndex("key", "key", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function loadPersistedData() {
    state.patients = await getAll("patients");
    state.labs = await getAll("labs");
    if (state.patients.length) {
      setUploadState("cohort", "Cargada", "ok");
      setUploadState("labs", state.labs.length ? "Con datos" : "Pendiente", state.labs.length ? "ok" : "pending");
      setLoadSummary(
        "Datos locales",
        `${state.patients.length.toLocaleString("es-CO")} pacientes`,
        `${state.labs.length.toLocaleString("es-CO")} paraclinicos en almacenamiento local.`,
      );
      setStatus(
        `<strong>${state.patients.length.toLocaleString("es-CO")}</strong> pacientes y ` +
          `<strong>${state.labs.length.toLocaleString("es-CO")}</strong> paraclinicos en almacenamiento local.`,
        "neutral",
      );
    }
  }

  function getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function putPatients(patients) {
    if (!patients.length) return;
    const tx = state.db.transaction("patients", "readwrite");
    const store = tx.objectStore("patients");
    patients.forEach((patient) => store.put(patient));
    await transactionDone(tx);
  }

  async function addLabs(labs) {
    if (!labs.length) return;
    const tx = state.db.transaction("labs", "readwrite");
    const store = tx.objectStore("labs");
    labs.forEach((lab) => {
      const localLab = { ...lab };
      delete localLab.dbId;
      store.add(localLab);
    });
    await transactionDone(tx);
  }

  async function clearStore(storeName) {
    const tx = state.db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    await transactionDone(tx);
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function clearAllData() {
    const confirmed = window.confirm("Borrar la cohorte, los paraclinicos y las tareas compartidas? Se creara un respaldo antes de borrar.");
    if (!confirmed) return;
    if (window.sharedClinical?.clearClinical) {
      await window.sharedClinical.clearClinical();
    }
    await clearStore("patients");
    await clearStore("labs");
    state.patients = [];
    state.labs = [];
    state.evaluated = [];
    state.filtered = [];
    state.managed = {};
    saveManagedState();
    setUploadState("cohort", "Pendiente", "pending");
    setUploadState("labs", "Pendiente", "pending");
    setLoadSummary("Estado del cargue", "Sin datos cargados", "Los datos quedan guardados en este navegador.");
    render();
    setStatus("Datos locales borrados.", "neutral");
  }

  function downloadDailyTemplate() {
    const rows = [
      ["tipo_identificacion", "numero_identificacion", "fecha_resultado", "examen", "valor", "unidad", "fuente", "observacion"],
      ["CC", "123456789", todayIso(), "Creatinina", "0.89", "mg/dl", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "TFG", "76", "ml/min", "Calculada", "Cockcroft-Gault"],
      ["CC", "123456789", todayIso(), "HbA1c", "7.2", "%", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "Relacion albuminuria/creatinuria", "22", "mg/g", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "Colesterol total", "178", "mg/dl", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "HDL", "48", "mg/dl", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "LDL", "96", "mg/dl", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "Trigliceridos", "151", "mg/dl", "Laboratorio", ""],
      ["CC", "123456789", todayIso(), "Presion arterial", "128/78", "mmHg", "Historia clinica", ""],
    ];
    downloadText("plantilla_paraclinicos_diarios.csv", toCsv(rows));
  }

  function downloadExcelTemplate() {
    const link = document.createElement("a");
    link.href = "./plantilla_cargue_cohorte_paraclinicos.xlsx";
    link.download = "plantilla_cargue_cohorte_paraclinicos.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function exportAlertsCsv() {
    const rows = [
      [
        "prioridad",
        "tipo_id",
        "numero_id",
        "paciente",
        "ips",
        "erc_estadio",
        "tfg_actual",
        "tfg_fecha",
        "creatinina_fecha_objetivo",
        "creatinina_alarma",
        "creatinina_ventana_inicio",
        "creatinina_ventana_fin",
        "creatinina_dias_vencido",
        "creatinina_dias_faltan_ventana",
        "creatinina_paciente_gestionado",
        "creatinina_cumple_algoritmo",
        "creatinina_resultado_algoritmo",
        "creatinina_dias_1_2",
        "creatinina_dias_2_3",
        "hba1c_fecha_objetivo",
        "hba1c_alarma",
        "hba1c_ventana_inicio",
        "hba1c_ventana_fin",
        "hba1c_dias_vencido",
        "hba1c_dias_faltan_ventana",
        "hba1c_paciente_gestionado",
        "microalbuminuria_acr_fecha_objetivo",
        "microalbuminuria_acr_alarma",
        "microalbuminuria_acr_ventana_inicio",
        "microalbuminuria_acr_ventana_fin",
        "microalbuminuria_acr_dias_vencido",
        "microalbuminuria_acr_dias_faltan_ventana",
        "microalbuminuria_acr_paciente_gestionado",
        "microalbuminuria_acr_cumple_algoritmo",
        "microalbuminuria_acr_resultado_algoritmo",
        "microalbuminuria_acr_dias_1_2",
        "microalbuminuria_acr_dias_2_3",
        "perfil_lipidico_fecha_objetivo",
        "perfil_lipidico_alarma",
        "perfil_lipidico_ventana_inicio",
        "perfil_lipidico_ventana_fin",
        "perfil_lipidico_dias_vencido",
        "perfil_lipidico_dias_faltan_ventana",
        "perfil_lipidico_paciente_gestionado",
        "creatinina_fecha",
        "albuminuria_acr_fecha",
        "hba1c_fecha",
        "perfil_lipidico_fecha",
        "acciones",
      ],
    ];
    state.filtered.forEach((item) => {
      const latest = item.latest;
      rows.push([
        item.severity,
        item.patient.type,
        item.patient.id,
        item.patient.name,
        item.patient.ips,
        item.patient.stage,
        latest.egfr?.value || "",
        latest.egfr?.date || "",
        ...scheduleCsvFields(item.scheduleMap.creatinine),
        managedCsvValue(item.patient, "creatinine"),
        ...algorithmCsvFields(item.algorithms.creatinine),
        ...scheduleCsvFields(item.scheduleMap.hba1c),
        managedCsvValue(item.patient, "hba1c"),
        ...scheduleCsvFields(item.scheduleMap.albuminuria),
        managedCsvValue(item.patient, "albuminuria"),
        ...algorithmCsvFields(item.algorithms.albuminuria),
        ...scheduleCsvFields(item.scheduleMap.lipids),
        managedCsvValue(item.patient, "lipids"),
        latest.creatinine?.date || "",
        newestOf(latest.albuminuria, latest.acr)?.date || "",
        latest.hba1c?.date || "",
        newestOf(latest.totalChol, latest.hdl, latest.ldl, latest.triglycerides)?.date || "",
        item.actions.join(" | "),
      ]);
    });
    downloadText(`alertas_renal_${todayIso()}.csv`, toCsv(rows));
  }

  function scheduleCsvFields(schedule) {
    if (!schedule) return ["", "Sin plan", "", "", "", ""];
    if (schedule.notApplicable) return ["", "No aplica", "", "", "NA", "NA"];
    return [
      schedule.missing ? "Tomar ahora" : schedule.dueDate || "",
      scheduleLabel(schedule),
      schedule.windowStart || "",
      schedule.windowEnd || "",
      schedule.missing ? "Sin registro" : schedule.overdueDays || 0,
      schedule.missing ? 0 : schedule.daysToWindow || 0,
    ];
  }

  function managedCsvValue(patient, labKeyName) {
    return state.managed[managedKey(patient, labKeyName)] ? "Si" : "No";
  }

  function algorithmCsvFields(algorithm) {
    if (!algorithm) return ["", "", "", ""];
    const compliance =
      algorithm.compliance === "no"
        ? "No"
        : algorithm.compliance === "oportunidad"
          ? "En oportunidad"
          : "Si";
    return [
      compliance,
      algorithm.result || "",
      algorithm.gaps[0]?.days ?? "",
      algorithm.gaps[1]?.days ?? "",
    ];
  }

  function exportBackupJson() {
    const backup = {
      createdAt: new Date().toISOString(),
      patients: state.patients,
      labs: state.labs,
      settings: getSettings(),
      managed: state.managed,
    };
    downloadText(`respaldo_vigilancia_renal_${todayIso()}.json`, JSON.stringify(backup, null, 2));
  }

  function downloadText(filename, text) {
    const blob = new Blob(["\ufeff", text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function toCsv(rows) {
    return rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? "");
            return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(";"),
      )
      .join("\n");
  }

  function setStatus(message, tone = "neutral") {
    els.statusStrip.innerHTML = message;
    els.statusStrip.dataset.tone = tone;
  }

  function setUploadState(kind, label, tone) {
    const element = kind === "cohort" ? els.cohortUploadState : els.labsUploadState;
    if (!element) return;
    element.textContent = label;
    element.className = `upload-state ${tone}`;
  }

  function setLoadSummary(title, value, note) {
    if (!els.loadSummary) return;
    els.loadSummary.innerHTML = `
      <span>${escapeHtml(title)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>`;
  }

  function setBusy(isBusy) {
    document.body.classList.toggle("is-busy", isBusy);
  }

  function findColumn(headers, candidates) {
    let best = -1;
    let bestScore = -Infinity;
    headers.forEach((header, index) => {
      const normalized = normalizeText(header);
      if (!normalized) return;
      for (const candidate of candidates) {
        const words = Array.isArray(candidate) ? candidate : [candidate];
        const matches = words.every((word) => normalized.includes(normalizeText(word)));
        if (!matches) continue;
        let score = words.length * 50 + Math.max(0, 40 - index / 5);
        if (normalized.includes("tipo") && !words.some((word) => normalizeText(word) === "tipo")) {
          score -= 100;
        }
        if (normalized.includes("fecha") && !words.some((word) => normalizeText(word) === "fecha")) {
          score -= 100;
        }
        if (normalized.includes("numero")) score += 25;
        if (normalized.includes("documento")) score += 20;
        if (score > bestScore) {
          best = index;
          bestScore = score;
        }
      }
    });
    return best;
  }

  function isDateHeader(header) {
    return normalizeText(header).includes("fecha") || normalizeText(header).includes("date");
  }

  function valueAt(row, index) {
    return index >= 0 ? row[index] : "";
  }

  function stringify(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function cleanId(value) {
    const text = stringify(value);
    if (!text) return "";
    return text.replace(/\.0$/, "").replace(/\s+/g, "").toUpperCase();
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function titleCase(value) {
    const text = stringify(value).toLowerCase();
    return text.replace(/\b[a-záéíóúñü]/gi, (letter) => letter.toUpperCase()).trim();
  }

  function isTruthyClinicalValue(value) {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    if (["1", "si", "s", "true", "confirmado", "positivo"].includes(normalized)) return true;
    if (normalized.includes("diagnostico") || normalized.includes("confirmado")) return true;
    return false;
  }

  function isDiabetesValue(value) {
    const normalized = normalizeText(value).replace(/\s+/g, "");
    if (!normalized || ["na", "no", "0", "sin", "sindato"].includes(normalized)) return false;
    if (isTruthyClinicalValue(value)) return true;
    if (/^e1[0-4]/.test(normalized)) return true;
    if (/^o24/.test(normalized)) return true;
    return normalizeText(value).includes("diabetes") || normalizeText(value).includes("dm");
  }

  function isGestationalDiabetesValue(value) {
    const normalized = normalizeText(value);
    const compact = normalized.replace(/\s+/g, "");
    return /^o24/.test(compact) || normalized.includes("gestacional") || normalized.includes("embarazo");
  }

  function isHtaValue(value) {
    const normalized = normalizeText(value).replace(/\s+/g, "");
    if (!normalized || ["na", "no", "0", "sin", "sindato"].includes(normalized)) return false;
    if (isTruthyClinicalValue(value)) return true;
    return /^i1[0-5]/.test(normalized) || normalized.includes("hta") || normalized.includes("hipertension");
  }

  function goalExclusionApplies(value, target) {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    const truthy = isTruthyClinicalValue(value);
    if (!truthy && !/(no apt|noapto|exclu|medico|no aplica)/.test(normalized)) return false;
    if (target === "bp") {
      return (
        truthy ||
        normalized.includes("presion") ||
        normalized.includes("tension") ||
        /\bpa\b/.test(normalized)
      );
    }
    if (target === "hba1c") {
      return truthy || normalized.includes("hba1c") || normalized.includes("hemoglobina");
    }
    return truthy;
  }

  function isInactiveStatus(value) {
    const normalized = normalizeText(value);
    return /fallecid|desafili|egreso|retirad|inactivo|suspendid|alta voluntaria|sin atenciones/.test(normalized);
  }

  function normalizeStage(value) {
    const normalized = normalizeText(value);
    const compact = normalized.replace(/\s+/g, "");
    const n18 = compact.match(/^n18([1-5])/);
    if (n18) return { number: Number(n18[1]), label: `Estadio ${n18[1]}` };
    const staged = compact.match(/(?:estadio|g)([1-5])/);
    if (staged) return { number: Number(staged[1]), label: `Estadio ${staged[1]}` };
    const match = normalized.match(/[1-5]/);
    if (match) return { number: Number(match[0]), label: `Estadio ${match[0]}` };
    if (normalized.includes("no aplica") || normalized === "98") {
      return { number: null, label: "No ERC" };
    }
    if (!normalized) return { number: null, label: "Sin dato" };
    return { number: null, label: stringify(value) };
  }

  function parseLabNumber(value, type) {
    const raw = stringify(value);
    if (!raw) return null;
    const numeric = Number(raw.replace(",", ".").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(numeric)) return null;

    const sentinels = {
      creatinine: [98, 99],
      egfr: [777, 988, 999],
      hba1c: [98, 99],
      albuminuria: [9888, 9999],
      acr: [9888, 9999],
      totalChol: [999],
      hdl: [999],
      ldl: [999],
      triglycerides: [999],
      systolicBp: [999],
      diastolicBp: [999],
    };
    if ((sentinels[type] || []).includes(numeric)) return null;
    if (type === "hba1c" && numeric > 30) return null;
    if (type === "creatinine" && numeric <= 0) return null;
    if (type === "egfr" && numeric <= 0) return null;
    if (type === "systolicBp" && (numeric < 50 || numeric > 260)) return null;
    if (type === "diastolicBp" && (numeric < 30 || numeric > 160)) return null;
    return numeric;
  }

  function parseBloodPressure(value) {
    const raw = stringify(value);
    if (!raw) return null;
    const matches = raw.match(/\d{2,3}(?:[.,]\d+)?/g);
    if (!matches || matches.length < 2) return null;
    const systolic = Number(matches[0].replace(",", "."));
    const diastolic = Number(matches[1].replace(",", "."));
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
    if (systolic < 50 || systolic > 260 || diastolic < 30 || diastolic > 160) return null;
    return { systolic, diastolic };
  }

  function parsePlainNumber(value) {
    const raw = stringify(value);
    if (!raw) return null;
    const numeric = Number(raw.replace(",", ".").replace(/[^\d.-]/g, ""));
    return Number.isFinite(numeric) ? numeric : null;
  }

  function parseDateValue(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") return excelSerialToIso(value);
    const raw = stringify(value);
    if (!raw) return "";
    if (/^(1800|1845|1847)-01-01/.test(raw)) return "";
    if (/^\d+(\.\d+)?$/.test(raw)) return excelSerialToIso(Number(raw));

    const iso = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

    const slash = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (slash) return isoDate(Number(slash[3]), Number(slash[2]), Number(slash[1]));

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return "";
  }

  function excelSerialToIso(serial) {
    if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return "";
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * MS_PER_DAY);
    return date.toISOString().slice(0, 10);
  }

  function isoDate(year, month, day) {
    if (!year || !month || !day) return "";
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return "";
    }
    return date.toISOString().slice(0, 10);
  }

  function todayIso() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function daysBetween(startIso, endIso) {
    const start = Date.parse(`${startIso}T00:00:00Z`);
    const end = Date.parse(`${endIso}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.round((end - start) / MS_PER_DAY);
  }

  function addDays(iso, days) {
    const time = Date.parse(`${iso}T00:00:00Z`);
    const date = new Date(time + days * MS_PER_DAY);
    return date.toISOString().slice(0, 10);
  }

  function compareIsoDates(a, b) {
    return String(a || "").localeCompare(String(b || ""));
  }

  function newestOf(...labs) {
    return labs
      .filter(Boolean)
      .sort((a, b) => compareIsoDates(b.date, a.date))[0];
  }

  function formatDate(date) {
    return date || "Sin fecha";
  }

  function formatDateOrEmpty(date) {
    return date || "";
  }

  function formatValue(value) {
    if (!Number.isFinite(Number(value))) return stringify(value);
    return Number(value).toLocaleString("es-CO", {
      maximumFractionDigits: 2,
    });
  }

  function formatPercent(value) {
    if (!Number.isFinite(Number(value))) return "0%";
    return Number(value).toLocaleString("es-CO", {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function parseDelimitedText(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (char === '"' && next === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        row.push(cell.trim());
        cell = "";
      } else if (char === "\n") {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = "";
      } else if (char !== "\r") {
        cell += char;
      }
    }
    row.push(cell.trim());
    if (row.some((value) => value)) rows.push(row);
    return rows;
  }

  function detectDelimiter(text) {
    const sample = text.slice(0, 4000);
    const counts = {
      ";": (sample.match(/;/g) || []).length,
      ",": (sample.match(/,/g) || []).length,
      "\t": (sample.match(/\t/g) || []).length,
    };
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  async function parseXlsx(buffer) {
    const files = await unzip(buffer);
    const workbookXml = await readZipText(files, "xl/workbook.xml");
    const relsXml = await readZipText(files, "xl/_rels/workbook.xml.rels");
    const sharedXml = files.get("xl/sharedStrings.xml")
      ? await readZipText(files, "xl/sharedStrings.xml")
      : "";
    const sheets = parseWorkbookSheets(workbookXml, relsXml);
    const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : [];
    const parsedSheets = [];

    for (const sheet of sheets) {
      const path = normalizeXlsxPath(sheet.path);
      const fileEntry = files.get(path);
      if (!fileEntry) continue;
      const xml = await readZipText(files, path);
      parsedSheets.push({
        name: sheet.name,
        rows: parseSheetXml(xml, sharedStrings),
      });
    }
    return { type: "xlsx", sheets: parsedSheets };
  }

  async function unzip(buffer) {
    const view = new DataView(buffer);
    const eocdOffset = findEndOfCentralDirectory(view);
    if (eocdOffset < 0) throw new Error("No se pudo leer el archivo XLSX.");

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
    let offset = centralDirectoryOffset;
    const files = new Map();

    for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("Directorio ZIP invalido.");
      }
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const nameBytes = new Uint8Array(buffer, offset + 46, fileNameLength);
      const name = new TextDecoder().decode(nameBytes).replace(/\\/g, "/");

      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);

      files.set(name, {
        name,
        method,
        compressed,
        uncompressedSize,
        text: null,
      });
      offset += 46 + fileNameLength + extraLength + commentLength;
    }
    return files;
  }

  function findEndOfCentralDirectory(view) {
    const minOffset = Math.max(0, view.byteLength - 65557);
    for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    return -1;
  }

  async function readZipText(files, path) {
    const entry = files.get(path);
    if (!entry) throw new Error(`No se encontro ${path} en el XLSX.`);
    if (entry.text !== null) return entry.text;
    let data;
    if (entry.method === 0) {
      data = entry.compressed;
    } else if (entry.method === 8) {
      const runtime = typeof window !== "undefined" ? window : globalThis;
      if ("DecompressionStream" in runtime && typeof runtime.DecompressionStream === "function") {
        const stream = new Blob([entry.compressed]).stream().pipeThrough(
          new runtime.DecompressionStream("deflate-raw"),
        );
        data = await new Response(stream).arrayBuffer();
      } else if (typeof runtime.__inflateRaw === "function") {
        data = await runtime.__inflateRaw(entry.compressed);
      } else {
        throw new Error("Este navegador no soporta lectura XLSX offline. Usa CSV o Edge/Chrome actualizado.");
      }
    } else {
      throw new Error("Compresion XLSX no soportada.");
    }
    entry.text = new TextDecoder("utf-8").decode(data);
    return entry.text;
  }

  function parseWorkbookSheets(workbookXml, relsXml) {
    const rels = parseRelationshipMap(relsXml);
    return xmlElements(workbookXml, "sheet").map((attrs) => {
      const id = readXmlAttribute(attrs, "r:id");
      return {
        name: readXmlAttribute(attrs, "name") || "Hoja",
        path: rels.get(id) || "",
      };
    });
  }

  function parseSharedStrings(xml) {
    return [...xml.matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g)].map((match) =>
      [...match[1].matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
        .map((textMatch) => decodeXml(textMatch[1]))
        .join(""),
    );
  }

  function parseSheetXml(xml, sharedStrings) {
    const rows = [];
    const rowPattern = /<(?:[\w.-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?row>/g;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(xml))) {
      const rowXml = rowMatch[1];
      const row = [];
      const cellPattern = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowXml))) {
        const attrs = cellMatch[1];
        const body = cellMatch[2] || "";
        const ref = readXmlAttribute(attrs, "r");
        const type = readXmlAttribute(attrs, "t");
        const columnIndex = ref ? cellRefToIndex(ref) : row.length;
        row[columnIndex] = decodeCellValue(body, type, sharedStrings);
      }
      if (row.some((value) => value !== undefined && value !== "")) rows.push(row);
    }
    return rows;
  }

  function decodeCellValue(body, type, sharedStrings) {
    if (type === "inlineStr") {
      const texts = [...body.matchAll(/<(?:[\w.-]+:)?t[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)].map((match) =>
        decodeXml(match[1]),
      );
      return texts.join("");
    }
    const valueMatch = body.match(/<(?:[\w.-]+:)?v[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/);
    if (!valueMatch) return "";
    const raw = decodeXml(valueMatch[1]);
    if (type === "s") return sharedStrings[Number(raw)] || "";
    if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
    return raw;
  }

  function readXmlAttribute(attrs, name) {
    const pattern = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`);
    const match = attrs.match(pattern);
    return match?.[1] || match?.[2] || "";
  }

  function parseRelationshipMap(xml) {
    const rels = new Map();
    xmlElements(xml, "Relationship").forEach((attrs) => {
      rels.set(readXmlAttribute(attrs, "Id"), readXmlAttribute(attrs, "Target"));
    });
    return rels;
  }

  function xmlElements(xml, tagName) {
    const pattern = new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b([^>]*)\\/?>`, "g");
    return [...xml.matchAll(pattern)].map((match) => match[1] || "");
  }

  function cellRefToIndex(ref) {
    const letters = (ref.match(/[A-Z]+/i)?.[0] || "A").toUpperCase();
    let index = 0;
    for (const letter of letters) {
      index = index * 26 + (letter.charCodeAt(0) - 64);
    }
    return index - 1;
  }

  function normalizeXlsxPath(path) {
    if (!path) return "";
    if (path.startsWith("/")) return path.slice(1);
    if (path.startsWith("xl/")) return path;
    return `xl/${path}`;
  }

  function decodeXml(value) {
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  const diagnosticsRoot = typeof window !== "undefined" ? window : globalThis;
  diagnosticsRoot.renalAlertDiagnostics = {
    parseXlsx,
    parseDelimitedText,
    transformCohortRows,
    transformDailyLabRows,
    evaluatePatient,
    computeContractIndicators(patients, labs, settings) {
      const labsByPatient = groupLabsByPatient(labs || []);
      const evaluatedItems = (patients || []).map((patient) =>
        evaluatePatient(patient, labsByPatient.get(patient.id) || [], settings),
      );
      return buildContractIndicators(settings, evaluatedItems);
    },
    snapshot() {
      return {
        patients: state.patients,
        labs: state.labs,
        evaluated: state.evaluated,
        settings: getSettings(),
      };
    },
  };
})();
