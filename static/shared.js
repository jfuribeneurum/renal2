(() => {
  "use strict";

  const ROUTE_TITLES = {
    dashboard: "Resumen de gestión",
    cohort: "Cohorte renal",
    tasks: "Tareas del equipo",
    indicators: "Gráficas de cohorte",
    imports: "Cargues compartidos",
    cac: "Malla CAC ERC",
    audit: "Trazabilidad",
    admin: "Administración",
  };
  const STATUS_LABELS = {
    pendiente: "Pendiente",
    en_gestion: "En gestión",
    programada: "Programada",
    completada: "Resuelta",
    cancelada: "Cancelada",
  };
  const ROLE_LABELS = {
    admin: "Administrador",
    clinico: "Clínico",
    gestor: "Gestor",
    auditor: "Auditor",
  };
  const EXAM_LABELS = {
    creatinine: "Creatinina",
    albuminuria: "Microalbuminuria/ACR",
    hba1c: "HbA1c",
    lipids: "Perfil lipídico",
    general: "Gestión general",
  };

  const LAB_IMPORT_BATCH_SIZE = 750;

  const state = {
    user: null,
    csrf: "",
    permissions: {},
    tasks: [],
    team: [],
    users: [],
    route: "dashboard",
    taskStatus: "all",
    cacJobs: [],
    cacPreview: null,
    cacJobId: "",
  };
  const els = {};
  let resolveReady;
  let readyReleased = false;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function releaseClinicalEngine() {
    if (readyReleased) return;
    readyReleased = true;
    resolveReady();
  }

  window.sharedClinical = {
    ready,
    async loadSnapshot() {
      const result = await api("/api/clinical/snapshot");
      refreshPatientOptions(result.patients || []);
      return result;
    },
    async syncCohort(patients, labs, fileName) {
      const importId = createImportId();
      const cohortResult = await api("/api/clinical/sync", {
        method: "POST",
        body: {
          mode: "cohort",
          patients,
          labs: [],
          file_name: fileName,
          import_id: importId,
          import_start: true,
          import_final: labs.length === 0,
        },
      });
      const labResult = await syncLabBatches(labs, fileName, importId, false);
      const result = {
        patients: cohortResult.patients,
        labs_added: labResult.labs_added,
        labs_skipped: labResult.labs_skipped,
      };
      await Promise.all([loadStats(), loadImports()]);
      toast(
        `Cohorte compartida: ${formatNumber(result.patients)} pacientes y ${formatNumber(result.labs_added)} resultados nuevos.` +
          (result.labs_skipped ? ` ${formatNumber(result.labs_skipped)} resultados no coincidieron con la cohorte.` : ""),
      );
      refreshPatientOptions(patients);
      return result;
    },
    async syncLabs(labs, fileName) {
      const result = await syncLabBatches(labs, fileName, createImportId(), true);
      await Promise.all([loadStats(), loadImports()]);
      toast(
        `${formatNumber(result.labs_added)} paraclínicos nuevos guardados en el servidor.` +
          (result.labs_skipped ? ` ${formatNumber(result.labs_skipped)} no coincidieron con pacientes activos.` : ""),
      );
      return result;
    },
    async manageExam({ patientId, examType, managed, dueDate }) {
      try {
        const result = await api("/api/tasks/from-exam", {
          method: "POST",
          body: {
            patient_id: patientId,
            exam_type: examType,
            managed,
            due_date: dueDate,
            priority: "alta",
          },
        });
        notifyClinicalTaskState(result.task);
        await Promise.all([loadTasks(), loadStats()]);
        toast(managed ? "La tarea quedó En gestión y ya aparece en el tablero." : "La tarea volvió a Pendiente.");
      } catch (error) {
        toast(error.message, "error");
        throw error;
      }
    },
    async clearClinical() {
      await api("/api/clinical/clear", { method: "DELETE" });
      await Promise.all([loadTasks(), loadStats(), loadImports()]);
      toast("Datos compartidos borrados después de crear un respaldo.");
    },
  };

  document.addEventListener("DOMContentLoaded", boot);

  async function boot() {
    bindElements();
    wireEvents();
    createIcons();
    try {
      const session = await api("/api/auth/me", {}, false);
      enterApplication(session);
    } catch {
      showLogin();
    }
  }

  function bindElements() {
    [
      "authLoading", "appLayout", "loginDialog", "loginForm", "loginEmail", "loginPassword", "loginError",
      "logoutButton", "pageTitle", "sidebarToggle", "quickTaskButton", "newTaskButton", "currentUserName",
      "currentUserRole", "userInitials", "sidebarTaskCount", "taskMetricPending", "taskMetricManaging",
      "taskMetricScheduled", "taskMetricOverdue", "dashboardTaskList", "dashboardWatchDate", "taskBoard",
      "onlyMyTasks", "taskDialog", "taskForm", "taskDialogTitle", "taskId", "taskTitle", "taskPatientId",
      "taskExam", "taskPriority", "taskStatus", "taskDueDate", "taskAssignee", "taskDescription", "taskNote",
      "taskHistory", "patientOptions", "importRows", "auditRows", "refreshAudit", "userList", "backupList",
      "newUserButton", "userDialog", "userForm", "userFullName", "userEmail", "userRole", "userPassword",
      "createBackupButton", "toastRegion", "watchDate", "passwordDialog", "passwordForm", "currentPassword",
      "newPassword", "confirmPassword", "passwordError", "cohortFile", "labsFile", "clearData", "taskSearch",
      "taskWorkflow", "taskContext", "cacConsultationsFile", "cacSupportFiles", "cacSettingsForm",
      "cacCutoffDate", "cacEapbCode", "cacIpsCode", "cacAffiliationDate", "cacEthnicity",
      "cacPopulationGroup", "cacProgramEntryDate", "cacHtnCost", "cacDmCost", "cacTotalCost",
      "cacTerritorialEntity", "cacConsultationsState", "cacSupportsState", "cacProgressLabel",
      "cacProgressBar", "processCacButton", "refreshCacJobs", "cacResults", "cacMetricPatients",
      "cacMetricSupports", "cacMetricReady", "cacMetricReview", "cacMetricCoverage", "cacResultTitle",
      "cacResultSubtitle", "downloadCacXlsx", "downloadCacTxt", "cacSearch", "cacStatusFilter",
      "cacVisibleCount", "cacPatientRows", "cacJobRows",
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function wireEvents() {
    els.loginForm.addEventListener("submit", login);
    els.logoutButton.addEventListener("click", logout);
    document.querySelectorAll("[data-route]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.route));
    });
    document.querySelectorAll("[data-go-route]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.goRoute));
    });
    els.sidebarToggle.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
    document.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close-dialog]");
      if (close) document.getElementById(close.dataset.closeDialog)?.close();
      const taskAction = event.target.closest("[data-task-action]");
      if (taskAction) {
        event.preventDefault();
        event.stopPropagation();
        transitionTask(taskAction.dataset.taskId, taskAction.dataset.taskAction);
        return;
      }
      const taskButton = event.target.closest("[data-task-patient-id]");
      if (taskButton) {
        openTaskDialog({
          patient_id: taskButton.dataset.taskPatientId,
          title: `Gestionar paraclínicos de ${taskButton.dataset.taskPatientName || taskButton.dataset.taskPatientId}`,
        });
      }
      const taskCard = event.target.closest("[data-task-id]");
      if (taskCard) openExistingTask(taskCard.dataset.taskId);
      const cacJobButton = event.target.closest("[data-cac-job-id]");
      if (cacJobButton) loadCacJob(cacJobButton.dataset.cacJobId);
    });
    [els.quickTaskButton, els.newTaskButton].forEach((button) => button.addEventListener("click", () => openTaskDialog()));
    document.querySelectorAll("[data-task-status]").forEach((button) => {
      button.addEventListener("click", async () => {
        state.taskStatus = button.dataset.taskStatus;
        document.querySelectorAll("[data-task-status]").forEach((item) => item.classList.toggle("active", item === button));
        await loadTasks();
      });
    });
    els.onlyMyTasks.addEventListener("change", loadTasks);
    els.taskSearch.addEventListener("input", renderTaskBoard);
    els.taskStatus.addEventListener("change", updateTaskWorkflow);
    els.taskWorkflow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-set-task-status]");
      if (!button || button.disabled) return;
      els.taskStatus.value = button.dataset.setTaskStatus;
      updateTaskWorkflow();
      if (els.taskStatus.value === "completada") {
        els.taskNote.placeholder = "Describe el resultado de la gestión para cerrar la tarea";
        els.taskNote.focus();
      }
    });
    els.taskForm.addEventListener("submit", saveTask);
    els.refreshAudit.addEventListener("click", loadAudit);
    els.newUserButton.addEventListener("click", () => els.userDialog.showModal());
    els.userForm.addEventListener("submit", createUser);
    els.passwordForm.addEventListener("submit", changePassword);
    els.createBackupButton.addEventListener("click", createBackup);
    if (els.watchDate) els.watchDate.addEventListener("change", updateWatchDate);
    els.cacConsultationsFile.addEventListener("change", updateCacFileStates);
    els.cacSupportFiles.addEventListener("change", updateCacFileStates);
    els.processCacButton.addEventListener("click", startCacProcess);
    els.refreshCacJobs.addEventListener("click", loadCacJobs);
    els.cacSearch.addEventListener("input", renderCacPatients);
    els.cacStatusFilter.addEventListener("change", renderCacPatients);
    els.downloadCacXlsx.addEventListener("click", () => downloadCacOutput("xlsx"));
    els.downloadCacTxt.addEventListener("click", () => downloadCacOutput("txt"));
  }

  async function api(path, options = {}, showAuthOn401 = true) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (state.csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && showAuthOn401) showLogin();
      throw new Error(data.error || `Error del servidor (${response.status}).`);
    }
    return data;
  }

  function showLogin() {
    els.authLoading.hidden = true;
    els.appLayout.hidden = true;
    els.loginError.textContent = "";
    if (!els.loginDialog.open) els.loginDialog.showModal();
    setTimeout(() => els.loginEmail.focus(), 50);
  }

  async function login(event) {
    event.preventDefault();
    els.loginError.textContent = "";
    const submit = els.loginForm.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const session = await api(
        "/api/auth/login",
        { method: "POST", body: { email: els.loginEmail.value, password: els.loginPassword.value } },
        false,
      );
      els.loginPassword.value = "";
      els.loginDialog.close();
      enterApplication(session);
    } catch (error) {
      els.loginError.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }

  async function enterApplication(session) {
    state.user = session.user;
    state.csrf = session.csrf_token;
    state.permissions = session.permissions || {};
    els.authLoading.hidden = true;
    els.appLayout.hidden = false;
    els.currentUserName.textContent = state.user.full_name;
    els.currentUserRole.textContent = ROLE_LABELS[state.user.role] || state.user.role;
    els.userInitials.textContent = initials(state.user.full_name);
    applyPermissions();
    fillAssignees();
    createIcons();
    // Keep the clinical grid independent from auxiliary task/admin panels.
    releaseClinicalEngine();
    const auxiliaryLoads = await Promise.allSettled([loadTeam(), loadTasks(), loadStats(), loadImports()]);
    const failedLoads = auxiliaryLoads.filter((result) => result.status === "rejected");
    if (failedLoads.length) {
      console.error("No se pudieron cargar uno o más paneles auxiliares.", failedLoads);
      toast("La cohorte está disponible, pero uno de los paneles administrativos no respondió.", "error");
    }
    fillAssignees();
    updateWatchDate();
    navigate("dashboard");
    if (state.user.must_change_password) {
      els.passwordError.textContent = "";
      els.passwordDialog.showModal();
      setTimeout(() => els.currentPassword.focus(), 50);
    }
  }

  async function syncLabBatches(labs, fileName, importId, startImport) {
    if (!labs.length) return { labs_added: 0, labs_skipped: 0 };
    let labsAdded = 0;
    let labsSkipped = 0;
    const totalBatches = Math.ceil(labs.length / LAB_IMPORT_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      const start = batchIndex * LAB_IMPORT_BATCH_SIZE;
      const batch = labs.slice(start, start + LAB_IMPORT_BATCH_SIZE);
      const result = await api("/api/clinical/sync", {
        method: "POST",
        body: {
          mode: "labs",
          labs: batch,
          file_name: fileName,
          import_id: importId,
          import_start: startImport && batchIndex === 0,
          import_final: batchIndex === totalBatches - 1,
        },
      });
      labsAdded += Number(result.labs_added || 0);
      labsSkipped += Number(result.labs_skipped || 0);
      updateClinicalImportProgress(Math.min(labs.length, start + batch.length), labs.length);
    }
    return { labs_added: labsAdded, labs_skipped: labsSkipped };
  }

  function updateClinicalImportProgress(processed, total) {
    const status = document.getElementById("statusStrip");
    if (!status || !total) return;
    const percent = Math.round((processed / total) * 100);
    status.dataset.tone = "neutral";
    status.textContent = `Guardando paraclínicos en el servidor: ${formatNumber(processed)} de ${formatNumber(total)} (${percent}%).`;
  }

  function createImportId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function applyPermissions() {
    document.querySelectorAll("[data-permission]").forEach((element) => {
      element.hidden = !state.permissions[element.dataset.permission];
    });
    const canWrite = Boolean(state.permissions.manage_tasks);
    document.body.dataset.readonly = canWrite ? "false" : "true";
    [els.quickTaskButton, els.newTaskButton].forEach((button) => {
      button.hidden = !canWrite;
    });
    els.cohortFile.disabled = !state.permissions.write_clinical;
    els.labsFile.disabled = !state.permissions.write_clinical;
    els.cacConsultationsFile.disabled = !state.permissions.write_clinical;
    els.cacSupportFiles.disabled = !state.permissions.write_clinical;
    els.processCacButton.hidden = !state.permissions.write_clinical;
    els.clearData.hidden = state.user.role !== "admin";
    document.querySelectorAll("label[for='cohortFile'], label[for='labsFile']").forEach((label) => {
      label.classList.toggle("disabled", !state.permissions.write_clinical);
    });
  }

  async function navigate(route) {
    if (!ROUTE_TITLES[route]) return;
    const nav = document.querySelector(`[data-route="${route}"]`);
    if (nav?.hidden) return;
    state.route = route;
    document.querySelectorAll("[data-view]").forEach((view) => {
      const active = view.dataset.view === route;
      view.hidden = !active;
      view.classList.toggle("active", active);
    });
    document.querySelectorAll("[data-route]").forEach((button) => button.classList.toggle("active", button.dataset.route === route));
    els.pageTitle.textContent = ROUTE_TITLES[route];
    document.body.classList.remove("sidebar-open");
    if (route === "tasks") await loadTasks();
    if (route === "imports") await loadImports();
    if (route === "cac") await loadCacJobs();
    if (route === "audit" && state.permissions.view_audit) await loadAudit();
    if (route === "admin" && state.permissions.manage_users) await Promise.all([loadUsers(), loadBackups()]);
    createIcons();
  }

  async function loadTeam() {
    try {
      const result = await api("/api/team");
      state.team = result.users || [];
      fillAssignees();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function fillAssignees(selected = "") {
    const users = state.team.length ? state.team : state.user ? [state.user] : [];
    els.taskAssignee.innerHTML = `<option value="">Sin asignar</option>${users
      .map((user) => `<option value="${escapeAttribute(user.id)}">${escapeHtml(user.full_name)} · ${escapeHtml(ROLE_LABELS[user.role] || user.role)}</option>`)
      .join("")}`;
    els.taskAssignee.value = selected || state.user?.id || "";
  }

  async function loadStats() {
    if (!state.user) return;
    const stats = await api("/api/stats");
    const tasks = stats.tasks || {};
    els.taskMetricPending.textContent = formatNumber(tasks.pending || 0);
    els.taskMetricManaging.textContent = formatNumber(tasks.managing || 0);
    els.taskMetricScheduled.textContent = formatNumber(tasks.scheduled || 0);
    els.taskMetricOverdue.textContent = formatNumber(tasks.overdue || 0);
    els.sidebarTaskCount.textContent = formatNumber((tasks.pending || 0) + (tasks.managing || 0) + (tasks.scheduled || 0));
  }

  async function loadTasks() {
    if (!state.user) return;
    const params = new URLSearchParams();
    if (els.onlyMyTasks?.checked) params.set("assigned", "me");
    const result = await api(`/api/tasks?${params.toString()}`);
    state.tasks = result.tasks || [];
    renderTaskBoard();
    renderDashboardTasks();
  }

  function renderTaskBoard() {
    const statuses = state.taskStatus === "all"
      ? ["pendiente", "en_gestion", "programada", "completada", "cancelada"]
      : [state.taskStatus];
    const query = String(els.taskSearch?.value || "").trim().toLocaleLowerCase("es");
    const visibleTasks = query
      ? state.tasks.filter((task) =>
          [task.title, task.patient_name, task.document, task.assignee_name, EXAM_LABELS[task.exam_type]]
            .some((value) => String(value || "").toLocaleLowerCase("es").includes(query)),
        )
      : state.tasks;
    els.taskBoard.innerHTML = statuses.map((status) => {
      const tasks = visibleTasks.filter((task) => task.status === status);
      return `<section class="task-column" data-column-status="${escapeAttribute(status)}">
        <header><h3>${escapeHtml(STATUS_LABELS[status])}</h3><span>${formatNumber(tasks.length)}</span></header>
        <div class="task-column-list">${tasks.length ? tasks.map(renderTaskCard).join("") : '<div class="empty-mini">Sin tareas</div>'}</div>
      </section>`;
    }).join("");
    createIcons();
  }

  function renderTaskCard(task) {
    const overdue = isOverdue(task) ? " overdue" : "";
    return `<article class="task-card${overdue}" data-task-id="${escapeAttribute(task.id)}" tabindex="0">
      <span class="priority-dot ${escapeAttribute(task.priority)}"></span>
      <div class="task-card-main">
        <div class="task-card-heading"><strong>${escapeHtml(task.title)}</strong><span class="status-pill ${escapeAttribute(task.status)}">${escapeHtml(STATUS_LABELS[task.status])}</span></div>
        <span>${escapeHtml(task.patient_name || task.document || "Sin paciente")} · ${escapeHtml(EXAM_LABELS[task.exam_type] || task.exam_type || "Gestión")}</span>
        <div class="task-card-meta"><span><i data-lucide="user-round"></i>${escapeHtml(task.assignee_name || "Sin asignar")}</span><span><i data-lucide="calendar-days"></i>${task.due_date ? formatDate(task.due_date) : "Sin fecha"}</span><span><i data-lucide="history"></i>${formatNumber(task.event_count || 0)} eventos</span></div>
        <div class="task-card-foot"><small>Actualizada ${escapeHtml(formatDateTime(task.updated_at))}</small>${renderTaskActions(task)}</div>
      </div>
    </article>`;
  }

  function renderTaskActions(task) {
    if (!state.permissions.manage_tasks || task.status === "cancelada") return "";
    if (task.status === "pendiente") {
      return `<button class="task-card-action" type="button" data-task-id="${escapeAttribute(task.id)}" data-task-action="en_gestion"><i data-lucide="play"></i> Iniciar</button>`;
    }
    if (task.status === "en_gestion" || task.status === "programada") {
      return `<button class="task-card-action resolve" type="button" data-task-id="${escapeAttribute(task.id)}" data-task-action="completada"><i data-lucide="check"></i> Resolver</button>`;
    }
    if (task.status === "completada") {
      return `<button class="task-card-action" type="button" data-task-id="${escapeAttribute(task.id)}" data-task-action="pendiente"><i data-lucide="rotate-ccw"></i> Reabrir</button>`;
    }
    return "";
  }

  function renderDashboardTasks() {
    const active = state.tasks.filter((task) => !["completada", "cancelada"].includes(task.status)).slice(0, 6);
    els.dashboardTaskList.innerHTML = active.length ? active.map((task) => `<article class="compact-task" data-task-id="${escapeAttribute(task.id)}">
      <span class="priority-dot ${escapeAttribute(task.priority)}"></span>
      <div class="compact-task-main"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.assignee_name || "Sin asignar")} · ${task.due_date ? formatDate(task.due_date) : "Sin fecha"}</span></div>
      <span class="status-pill ${escapeAttribute(task.status)}">${escapeHtml(STATUS_LABELS[task.status])}</span>
    </article>`).join("") : '<div class="empty-mini">No hay tareas pendientes.</div>';
  }

  function openTaskDialog(seed = {}) {
    if (!state.permissions.manage_tasks) return;
    els.taskForm.reset();
    els.taskForm.querySelectorAll("input,select,textarea").forEach((control) => {
      control.disabled = false;
    });
    els.taskId.value = "";
    els.taskDialogTitle.textContent = "Nueva tarea";
    els.taskTitle.value = seed.title || "";
    els.taskPatientId.value = seed.patient_id || "";
    els.taskStatus.value = "pendiente";
    els.taskPriority.value = "media";
    els.taskContext.hidden = true;
    els.taskHistory.hidden = true;
    fillAssignees(state.user.id);
    updateTaskWorkflow();
    els.taskDialog.showModal();
    createIcons();
    setTimeout(() => els.taskTitle.focus(), 30);
  }

  async function openExistingTask(taskId, nextStatus = "") {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    els.taskForm.reset();
    els.taskId.value = task.id;
    els.taskDialogTitle.textContent = "Detalle y trazabilidad";
    els.taskTitle.value = task.title || "";
    els.taskPatientId.value = task.patient_id || "";
    els.taskExam.value = task.exam_type || "general";
    els.taskPriority.value = task.priority;
    els.taskStatus.value = nextStatus || task.status;
    els.taskDueDate.value = task.due_date || "";
    els.taskDescription.value = task.description || "";
    els.taskNote.value = "";
    els.taskNote.placeholder = nextStatus === "completada"
      ? "Describe el resultado de la gestión para cerrar la tarea"
      : "Registra contacto, novedad o motivo del cambio";
    fillAssignees(task.assigned_to || "");
    els.taskContext.hidden = false;
    els.taskContext.innerHTML = `<span><i data-lucide="user-plus"></i> Creada por <strong>${escapeHtml(task.creator_name || "Usuario")}</strong></span><span><i data-lucide="clock-3"></i> ${escapeHtml(formatDateTime(task.created_at))}</span>${task.closer_name ? `<span><i data-lucide="circle-check"></i> Resuelta por <strong>${escapeHtml(task.closer_name)}</strong></span>` : ""}`;
    const editable = Boolean(state.permissions.manage_tasks);
    els.taskForm.querySelectorAll("input,select,textarea").forEach((control) => {
      control.disabled = !editable;
    });
    els.taskForm.querySelector("button[type=submit]").hidden = !editable;
    els.taskWorkflow.querySelectorAll("button").forEach((button) => {
      button.disabled = !editable;
    });
    updateTaskWorkflow();
    els.taskDialog.showModal();
    createIcons();
    const history = await api(`/api/tasks/${encodeURIComponent(task.id)}/history`);
    els.taskHistory.hidden = false;
    els.taskHistory.innerHTML = (history.events || []).map((event) => `<div class="history-event"><i></i><div><strong>${escapeHtml(event.actor_name)} · ${escapeHtml(eventLabel(event))}</strong><p>${escapeHtml(formatDateTime(event.created_at))}${event.note ? ` · ${escapeHtml(event.note)}` : ""}</p></div></div>`).join("") || '<div class="empty-mini">Sin eventos.</div>';
    if (nextStatus === "completada") setTimeout(() => els.taskNote.focus(), 30);
  }

  async function saveTask(event) {
    event.preventDefault();
    const id = els.taskId.value;
    const current = id ? state.tasks.find((task) => task.id === id) : null;
    const body = {
      patient_id: els.taskPatientId.value.trim() || null,
      title: els.taskTitle.value.trim(),
      exam_type: els.taskExam.value,
      priority: els.taskPriority.value,
      status: els.taskStatus.value,
      due_date: els.taskDueDate.value || null,
      assigned_to: els.taskAssignee.value || null,
      description: els.taskDescription.value.trim(),
      note: els.taskNote.value.trim(),
    };
    if (current && current.status !== body.status && !body.note) {
      toast("Escribe una nota para dejar trazabilidad del cambio de estado.", "error");
      els.taskNote.focus();
      return;
    }
    try {
      const result = await api(id ? `/api/tasks/${encodeURIComponent(id)}` : "/api/tasks", { method: id ? "PATCH" : "POST", body });
      notifyClinicalTaskState(result.task);
      els.taskDialog.close();
      await Promise.all([loadTasks(), loadStats()]);
      toast(id ? "Tarea actualizada y registrada en la trazabilidad." : "Tarea creada y asignada.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function transitionTask(taskId, nextStatus) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !state.permissions.manage_tasks) return;
    if (nextStatus === "completada") {
      await openExistingTask(taskId, nextStatus);
      return;
    }
    const actionLabel = nextStatus === "en_gestion" ? "Inició la gestión desde el tablero." : "Reabrió la tarea desde el tablero.";
    try {
      const result = await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: {
          status: nextStatus,
          assigned_to: nextStatus === "en_gestion" ? state.user.id : task.assigned_to,
          note: actionLabel,
        },
      });
      notifyClinicalTaskState(result.task);
      await Promise.all([loadTasks(), loadStats()]);
      toast(nextStatus === "en_gestion" ? "La tarea pasó a En gestión." : "La tarea volvió a Pendiente.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function updateTaskWorkflow() {
    const status = els.taskStatus.value;
    els.taskWorkflow.querySelectorAll("[data-set-task-status]").forEach((button) => {
      button.classList.toggle("active", button.dataset.setTaskStatus === status);
    });
  }

  function notifyClinicalTaskState(task) {
    if (!task?.patient_id || !task?.exam_type) return;
    window.dispatchEvent(new CustomEvent("renal:task-state", { detail: task }));
  }

  async function loadImports() {
    if (!state.user) return;
    const result = await api("/api/imports");
    const imports = result.imports || [];
    els.importRows.innerHTML = imports.length ? imports.map((item) => `<tr><td>${escapeHtml(formatDateTime(item.created_at))}</td><td>${item.import_type === "cohort" ? "Cohorte" : "Paraclínicos"}</td><td>${escapeHtml(item.file_name || "Sin nombre")}</td><td>${formatNumber(item.record_count)}</td><td>${formatNumber(item.lab_count)}</td><td>${escapeHtml(item.imported_by_name)}</td></tr>`).join("") : '<tr><td colspan="6">Sin cargues registrados.</td></tr>';
  }

  function updateCacFileStates() {
    const consultations = els.cacConsultationsFile.files?.[0];
    const supports = Array.from(els.cacSupportFiles.files || []);
    els.cacConsultationsState.textContent = consultations ? consultations.name : "Pendiente";
    els.cacConsultationsState.className = `upload-state ${consultations ? "ok" : "pending"}`;
    els.cacSupportsState.textContent = supports.length ? `${formatNumber(supports.length)} PDF` : "Pendiente";
    els.cacSupportsState.className = `upload-state ${supports.length ? "ok" : "pending"}`;
  }

  function setCacProgress(percent, label) {
    els.cacProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    els.cacProgressLabel.textContent = label;
  }

  function cacSettings() {
    return {
      cutoff_date: els.cacCutoffDate.value,
      eapb_code: els.cacEapbCode.value.trim(),
      ips_code: els.cacIpsCode.value.trim(),
      affiliation_date: els.cacAffiliationDate.value,
      ethnicity_code: els.cacEthnicity.value,
      population_group: els.cacPopulationGroup.value.trim(),
      program_entry_date: els.cacProgramEntryDate.value,
      htn_cost_default: els.cacHtnCost.value,
      dm_cost_default: els.cacDmCost.value,
      total_cost_default: els.cacTotalCost.value,
      territorial_entity: els.cacTerritorialEntity.checked,
    };
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`No fue posible leer ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function startCacProcess() {
    const consultations = els.cacConsultationsFile.files?.[0];
    const supports = Array.from(els.cacSupportFiles.files || []);
    if (!consultations) {
      toast("Selecciona el Excel de atenciones.", "error");
      return;
    }
    els.processCacButton.disabled = true;
    document.body.classList.add("cac-processing");
    try {
      setCacProgress(3, "Creando proceso seguro...");
      const created = await api("/api/cac/jobs", {
        method: "POST",
        body: { settings: cacSettings() },
      });
      const jobId = created.job.id;
      state.cacJobId = jobId;

      setCacProgress(10, `Cargando ${consultations.name}...`);
      await api(`/api/cac/jobs/${encodeURIComponent(jobId)}/consultations`, {
        method: "POST",
        body: {
          file_name: consultations.name,
          data_base64: await fileAsDataUrl(consultations),
        },
      });

      for (let index = 0; index < supports.length; index += 1) {
        const support = supports[index];
        const percent = 15 + Math.round(((index + 1) / Math.max(supports.length, 1)) * 55);
        setCacProgress(percent, `Cargando soporte ${index + 1} de ${supports.length}...`);
        await api(`/api/cac/jobs/${encodeURIComponent(jobId)}/supports`, {
          method: "POST",
          body: {
            file_name: support.name,
            data_base64: await fileAsDataUrl(support),
          },
        });
      }

      setCacProgress(76, "Consolidando atenciones y verificando soportes...");
      const result = await api(`/api/cac/jobs/${encodeURIComponent(jobId)}/process`, {
        method: "POST",
        body: {},
      });
      state.cacPreview = { summary: result.summary, settings: result.settings, patients: result.patients };
      renderCacPreview(state.cacPreview, jobId);
      await loadCacJobs();
      setCacProgress(100, "Malla generada y validación completada");
      toast(`Malla generada para ${formatNumber(result.summary.patients)} pacientes.`);
    } catch (error) {
      setCacProgress(0, "El proceso requiere corrección");
      toast(error.message, "error", 7000);
    } finally {
      els.processCacButton.disabled = false;
      document.body.classList.remove("cac-processing");
    }
  }

  async function loadCacJobs() {
    if (!state.user) return;
    try {
      const result = await api("/api/cac/jobs");
      state.cacJobs = result.jobs || [];
      renderCacJobs();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function renderCacJobs() {
    els.cacJobRows.innerHTML = state.cacJobs.length
      ? state.cacJobs.map((job) => {
          const summary = job.summary || {};
          const status = job.status === "completado" ? "Completado" : job.status === "error" ? "Error" : job.status === "procesando" ? "Procesando" : "Cargando";
          return `<tr>
            <td>${escapeHtml(formatDateTime(job.created_at))}</td>
            <td><span class="cac-status ${escapeAttribute(job.status)}">${escapeHtml(status)}</span></td>
            <td>${formatNumber(summary.source_records || 0)}</td>
            <td>${formatNumber(job.support_count || 0)}</td>
            <td>${formatNumber(summary.ready || 0)}</td>
            <td>${formatNumber(summary.review || 0)}</td>
            <td>${escapeHtml(job.created_by_name || "")}</td>
            <td><button class="icon-only" type="button" data-cac-job-id="${escapeAttribute(job.id)}" aria-label="Abrir resultado"><i data-lucide="arrow-up-right"></i></button></td>
          </tr>`;
        }).join("")
      : '<tr><td colspan="8">Sin procesos de malla registrados.</td></tr>';
    createIcons();
  }

  async function loadCacJob(jobId) {
    try {
      const result = await api(`/api/cac/jobs/${encodeURIComponent(jobId)}`);
      state.cacJobId = jobId;
      state.cacPreview = result.preview && result.preview.summary ? result.preview : null;
      if (state.cacPreview) {
        renderCacPreview(state.cacPreview, jobId);
        els.cacResults.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        toast(result.job.error_message || "Este proceso todavía no tiene resultados.", result.job.status === "error" ? "error" : "ok");
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function renderCacPreview(preview, jobId) {
    const summary = preview.summary || {};
    state.cacPreview = preview;
    state.cacJobId = jobId;
    els.cacResults.hidden = false;
    els.cacMetricPatients.textContent = formatNumber(summary.patients);
    els.cacMetricSupports.textContent = formatNumber(summary.matched_supports);
    els.cacMetricReady.textContent = formatNumber(summary.ready);
    els.cacMetricReview.textContent = formatNumber(summary.review);
    els.cacMetricCoverage.textContent = `${Number(summary.average_coverage || 0).toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`;
    els.cacResultTitle.textContent = `${formatNumber(summary.patients)} pacientes · ${formatNumber(summary.source_records)} atenciones`;
    els.cacResultSubtitle.textContent = `${formatNumber(summary.unmatched_supports)} soportes sin coincidencia y ${formatNumber(summary.without_support)} pacientes sin PDF cargado.`;
    els.downloadCacTxt.disabled = !summary.txt_name;
    els.downloadCacTxt.title = summary.txt_name ? "" : "Solo se habilita cuando existen registros sin errores bloqueantes";
    renderCacPatients();
    createIcons();
  }

  function renderCacPatients() {
    const patients = state.cacPreview?.patients || [];
    const query = String(els.cacSearch.value || "").trim().toLocaleLowerCase("es");
    const status = els.cacStatusFilter.value;
    const filtered = patients.filter((patient) => {
      if (status !== "all" && patient.status !== status) return false;
      if (!query) return true;
      return [patient.document, patient.patient].some((value) => String(value || "").toLocaleLowerCase("es").includes(query));
    });
    const visible = filtered.slice(0, 400);
    els.cacVisibleCount.textContent = `${formatNumber(filtered.length)} registros${filtered.length > visible.length ? " · mostrando 400" : ""}`;
    els.cacPatientRows.innerHTML = visible.length
      ? visible.map((patient) => {
          const key = patient.key_values || {};
          const issues = patient.errors?.length ? patient.errors : patient.warnings || [];
          const issueText = issues.slice(0, 3).join(" · ");
          return `<tr>
            <td><span class="cac-status ${escapeAttribute(patient.status.toLocaleLowerCase("es").replace(/\s+/g, "-"))}">${escapeHtml(patient.status)}</span></td>
            <td>${escapeHtml(patient.document_type || "")}</td>
            <td><strong>${escapeHtml(patient.document)}</strong></td>
            <td>${escapeHtml(patient.patient)}</td>
            <td><span class="coverage-meter"><i style="width:${Number(patient.coverage || 0)}%"></i></span><small>${escapeHtml(patient.coverage)}%</small></td>
            <td>${formatNumber(patient.support_count)}</td>
            <td>${escapeHtml(formatDate(patient.latest_support))}</td>
            <td>${escapeHtml(key.tfg ?? "")}</td>
            <td>${escapeHtml(key.creatinine ?? "")}<small>${escapeHtml(formatDate(key.creatinine_date))} · ${escapeHtml(key.creatinine_source || "")}</small></td>
            <td>${escapeHtml(key.hba1c ?? "")}<small>${escapeHtml(formatDate(key.hba1c_date))} · ${escapeHtml(key.hba1c_source || "")}</small></td>
            <td>${escapeHtml(key.rac ?? "")}<small>${escapeHtml(formatDate(key.rac_date))} · ${escapeHtml(key.rac_source || "")}</small></td>
            <td class="cac-issues" title="${escapeAttribute(issues.join(" | "))}">${escapeHtml(issueText || "Sin hallazgos")}</td>
          </tr>`;
        }).join("")
      : '<tr><td colspan="12">No hay pacientes para este filtro.</td></tr>';
  }

  function downloadCacOutput(outputType) {
    if (!state.cacJobId) return;
    if (outputType === "txt" && !state.cacPreview?.summary?.txt_name) {
      toast("El TXT se habilita cuando existen registros sin errores bloqueantes.", "error");
      return;
    }
    window.location.assign(`/api/cac/jobs/${encodeURIComponent(state.cacJobId)}/download/${outputType}`);
  }

  async function loadAudit() {
    try {
      const result = await api("/api/audit?limit=500");
      els.auditRows.innerHTML = (result.entries || []).map((entry) => `<tr><td>${escapeHtml(formatDateTime(entry.created_at))}</td><td>${escapeHtml(entry.actor_name || entry.actor_email || "Sistema")}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.entity_type)} ${escapeHtml(entry.entity_id || "")}</td><td>${escapeHtml(summarizeDetails(entry.details))}</td></tr>`).join("") || '<tr><td colspan="5">Sin eventos.</td></tr>';
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function loadUsers() {
    const result = await api("/api/users");
    state.users = result.users || [];
    els.userList.innerHTML = state.users.map((user) => `<article class="user-row"><div><strong>${escapeHtml(user.full_name)}</strong><span>${escapeHtml(user.email)}</span></div><span class="role-badge">${escapeHtml(ROLE_LABELS[user.role] || user.role)}</span></article>`).join("") || '<div class="empty-mini">Sin usuarios.</div>';
  }

  async function createUser(event) {
    event.preventDefault();
    try {
      await api("/api/users", { method: "POST", body: { full_name: els.userFullName.value, email: els.userEmail.value, role: els.userRole.value, password: els.userPassword.value } });
      els.userDialog.close();
      els.userForm.reset();
      await Promise.all([loadUsers(), loadTeam()]);
      toast("Usuario creado. Deberá cambiar su contraseña temporal.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    els.passwordError.textContent = "";
    if (els.newPassword.value !== els.confirmPassword.value) {
      els.passwordError.textContent = "Las contraseñas nuevas no coinciden.";
      return;
    }
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { current_password: els.currentPassword.value, new_password: els.newPassword.value },
      });
      state.user.must_change_password = false;
      els.passwordForm.reset();
      els.passwordDialog.close();
      toast("Contraseña actualizada correctamente.");
    } catch (error) {
      els.passwordError.textContent = error.message;
    }
  }

  async function loadBackups() {
    const result = await api("/api/backups");
    els.backupList.innerHTML = (result.backups || []).map((backup) => `<article class="backup-row"><div><strong>${escapeHtml(backup.name)}</strong><span>${escapeHtml(formatDateTime(backup.created_at))} · ${formatBytes(backup.size)}</span></div><a class="icon-button" href="/api/backups/${encodeURIComponent(backup.name)}"><i data-lucide="download"></i></a></article>`).join("") || '<div class="empty-mini">Aún no hay respaldos.</div>';
    createIcons();
  }

  async function createBackup() {
    try {
      await api("/api/backups", { method: "POST", body: {} });
      await loadBackups();
      toast("Respaldo completo creado correctamente.");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function refreshPatientOptions(patients) {
    if (!els.patientOptions) return;
    els.patientOptions.innerHTML = patients.slice(0, 12000).map((patient) => `<option value="${escapeAttribute(patient.id)}">${escapeHtml(patient.name || patient.id)}</option>`).join("");
  }

  function updateWatchDate() {
    const value = els.watchDate?.value;
    els.dashboardWatchDate.textContent = value ? formatDate(value) : new Intl.DateTimeFormat("es-CO", { dateStyle: "long" }).format(new Date());
  }

  function createIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function toast(message, type = "ok", duration = 4200) {
    const element = document.createElement("div");
    element.className = `toast ${type === "error" ? "error" : ""}`;
    element.textContent = message;
    els.toastRegion.appendChild(element);
    setTimeout(() => element.remove(), duration);
  }

  function eventLabel(event) {
    if (event.event_type === "creada") return `Creó la tarea (${STATUS_LABELS[event.to_status] || event.to_status})`;
    if (event.event_type === "estado") return `Cambió de ${STATUS_LABELS[event.from_status] || event.from_status} a ${STATUS_LABELS[event.to_status] || event.to_status}`;
    if (event.event_type === "nota") return "Agregó una nota";
    return "Actualizó la tarea";
  }

  function isOverdue(task) {
    return task.due_date && !["completada", "cancelada"].includes(task.status) && task.due_date < new Date().toISOString().slice(0, 10);
  }

  function summarizeDetails(details) {
    if (!details || typeof details !== "object") return "";
    return Object.entries(details).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join(" · ");
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric" }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("es-CO");
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function initials(name) {
    return String(name || "NU").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
