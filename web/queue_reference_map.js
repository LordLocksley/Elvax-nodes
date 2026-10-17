import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxQueueReferenceMap";
const POLL_INTERVAL_MS = 2500;
const MIN_WIDGET_HEIGHT = 360;
const QUEUE_DB_NAME = "elvax-queue-reference-map";
const QUEUE_DB_STORE = "state";
const QUEUE_STATE_KEY = "paused-queue";
const nodeViews = new Set();
let pollTimer = null;
let refreshTimer = null;
let refreshInProgress = false;
let serverQueueItems = [];
let queueState = { paused: false, jobs: [] };
let queueActionInProgress = false;
let queueStateError = null;
let queueStorageReady = false;
let submitQueuePrompt = null;
let activePromptSubmissions = 0;
let promptSubmissionWaiters = [];

const queueDbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open(QUEUE_DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(QUEUE_DB_STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}).then(async (db) => {
  const stored = await new Promise((resolve, reject) => {
    const request = db.transaction(QUEUE_DB_STORE, "readonly").objectStore(QUEUE_DB_STORE).get(QUEUE_STATE_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (stored && Array.isArray(stored.jobs)) queueState = stored;
  queueStorageReady = true;
  return db;
}).catch((error) => {
  queueStateError = error;
  return null;
});
queueDbReady.then(renderQueueViews);

async function persistQueueState() {
  const db = await queueDbReady;
  if (!db) throw queueStateError || new Error("Persistent queue storage is unavailable.");
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_DB_STORE, "readwrite");
    transaction.objectStore(QUEUE_DB_STORE).put(queueState, QUEUE_STATE_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function makeQueueSnapshot(tuple) {
  const extraData = tuple[3] || {};
  return {
    key: `paused-${tuple[1]}`,
    promptId: tuple[1],
    number: tuple[0],
    prompt: tuple[2] || {},
    workflow: extraData.extra_pnginfo?.workflow || null,
    options: {
      ...(Array.isArray(tuple[4]) && tuple[4].length ? { partialExecutionTargets: tuple[4] } : {}),
      ...(extraData.preview_method ? { previewMethod: extraData.preview_method } : {}),
    },
  };
}

function installQueuePauseHook() {
  if (api.__elvaxQueuePauseHook) {
    submitQueuePrompt = api.__elvaxQueuePauseHook;
    return;
  }
  const originalQueuePrompt = api.queuePrompt;
  if (typeof originalQueuePrompt !== "function") return;
  submitQueuePrompt = originalQueuePrompt;
  api.__elvaxQueuePauseHook = originalQueuePrompt;
  api.queuePrompt = async function (number, promptData, options) {
    await queueDbReady;
    if (!queueState.paused) {
      activePromptSubmissions += 1;
      try {
        return await originalQueuePrompt.call(this, number, promptData, options);
      } finally {
        activePromptSubmissions -= 1;
        if (!activePromptSubmissions) promptSubmissionWaiters.splice(0).forEach((resolve) => resolve());
      }
    }

    const job = {
      key: `paused-${crypto.randomUUID()}`,
      promptId: null,
      number,
      prompt: structuredClone(promptData?.output || {}),
      workflow: structuredClone(promptData?.workflow || null),
      options: structuredClone(options || {}),
    };
    queueState.jobs.push(job);
    try {
      await persistQueueState();
    } catch (error) {
      queueState.jobs = queueState.jobs.filter((candidate) => candidate !== job);
      renderQueueViews();
      throw error;
    }
    renderQueueViews();
    app.extensionManager?.toast?.add({
      severity: "info",
      summary: "Queue paused",
      detail: "This workflow was saved and will run when you resume the queue.",
      life: 4000,
    });
    // A server prompt ID is assigned when the saved job is resumed.
    return { node_errors: {} };
  };
}

function waitForPromptSubmissions() {
  if (!activePromptSubmissions) return Promise.resolve();
  return new Promise((resolve) => promptSubmissionWaiters.push(resolve));
}

installQueuePauseHook();

function updateQueueControls(view) {
  view.pauseButton.textContent = queueState.paused ? "Resume Queue" : "Pause Queue";
  view.pauseButton.disabled = queueActionInProgress || !queueStorageReady || !!queueStateError;
  view.queueStatus.textContent = queueState.paused
    ? `Paused (saved) : ${queueState.jobs.length}`
    : "";
}

function updateAllQueueControls() {
  for (const view of nodeViews) updateQueueControls(view);
}

async function pauseQueue(view) {
  if (queueActionInProgress || queueState.paused) return;
  queueActionInProgress = true;
  updateAllQueueControls();
  try {
    await queueDbReady;
    if (!submitQueuePrompt) throw new Error("ComfyUI prompt submission is not available.");
    queueState.paused = true;
    await persistQueueState();
    await waitForPromptSubmissions();

    const response = await api.fetchApi("/queue");
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const queue = await response.json();
    const pending = queue.queue_pending || [];
    const knownIds = new Set(queueState.jobs.map((job) => job.promptId).filter(Boolean));
    const newJobs = pending.slice().sort((a, b) => a[0] - b[0])
      .filter((tuple) => !knownIds.has(tuple[1])).map(makeQueueSnapshot);
    queueState.jobs.push(...newJobs);
    await persistQueueState();

    if (pending.length) {
      const removeResponse = await api.fetchApi("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: pending.map((tuple) => tuple[1]) }),
      });
      if (!removeResponse.ok) throw new Error(`Could not remove pending jobs (${removeResponse.status}).`);
    }
    view.signature = null;
    refreshQueue();
  } catch (error) {
    view.error.textContent = `Could not pause queue: ${error.message || "request failed"}`;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function resumeQueue(view) {
  if (queueActionInProgress || !queueState.paused) return;
  queueActionInProgress = true;
  updateAllQueueControls();
  try {
    await queueDbReady;
    while (queueState.jobs.length) {
      const job = queueState.jobs[0];
      await submitQueuePrompt.call(api, 0, {
        output: job.prompt,
        workflow: job.workflow,
      }, job.options || {});
      queueState.jobs.shift();
      await persistQueueState();
    }
    queueState.paused = false;
    await persistQueueState();
    view.signature = null;
    refreshQueue();
  } catch (error) {
    view.error.textContent = `Could not resume queue: ${error.message || "request failed"}`;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function toggleQueue(view) {
  if (queueState.paused) await resumeQueue(view);
  else await pauseQueue(view);
}

async function removePausedJob(job, view) {
  const index = queueState.jobs.findIndex((candidate) => candidate.key === job.key);
  if (index < 0) return;
  queueState.jobs.splice(index, 1);
  await persistQueueState();
  view.signature = null;
  refreshQueue();
}

function nodeOrder(prompt, extraData) {
  const workflowNodes = extraData?.extra_pnginfo?.workflow?.nodes || [];
  const ids = workflowNodes.map((node) => String(node.id));
  for (const id of Object.keys(prompt || {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => [id, prompt?.[id]]).filter(([, node]) => node);
}

function findFirstImage(prompt, extraData) {
  for (const [id, node] of nodeOrder(prompt, extraData)) {
    if (!/load[\w]*image/i.test(node.class_type || "")) continue;
    const workflowNode = (extraData?.extra_pnginfo?.workflow?.nodes || [])
      .find((candidate) => String(candidate.id) === id);
    const value = node.inputs?.image ?? workflowNode?.widgets_values?.[0];
    let filename = value;
    let subfolder = node.inputs?.subfolder || "";
    let type = node.inputs?.type || "input";
    if (value && typeof value === "object") {
      filename = value.filename || value.name || value.asset_hash;
      subfolder = value.subfolder ?? subfolder;
      type = value.type ?? type;
    }
    if (typeof filename !== "string" || !filename.trim()) continue;

    const match = filename.match(/^(.*?)(?:\s+\[(input|output|temp)\])?$/i);
    filename = match?.[1] || filename;
    const pathParts = filename.replace(/\\/g, "/").split("/");
    if (pathParts.length > 1 && !subfolder) {
      subfolder = pathParts.slice(0, -1).join("/");
      filename = pathParts[pathParts.length - 1];
    }
    return {
      filename,
      type: (match?.[2] || type).toLowerCase(),
      subfolder,
    };
  }
  return null;
}

function resolveText(value, prompt, seen = new Set()) {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value) || value.length < 2) return null;

  const sourceId = String(value[0]);
  if (seen.has(sourceId)) return null;
  const source = prompt?.[sourceId];
  if (!source) return null;

  const nextSeen = new Set(seen).add(sourceId);
  const sourceInputs = source.inputs || {};
  for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
    const text = resolveText(sourceInputs[key], prompt, nextSeen);
    if (text) return text;
  }
  return null;
}

function findFirstPrompt(prompt, extraData) {
  for (const [, node] of nodeOrder(prompt, extraData)) {
    if (!/(cliptextencode|text.*multiline|prompt)/i.test(node.class_type || "")) continue;
    const inputs = node.inputs || {};
    for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
      const text = resolveText(inputs[key], prompt);
      if (text) return text;
    }
  }
  return null;
}

function queueItem(tuple, state) {
  return {
    promptId: tuple[1],
    prompt: tuple[2] || {},
    extraData: tuple[3] || {},
    state,
  };
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function addStyles() {
  if (document.getElementById(`${NODE_TYPE}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${NODE_TYPE}-styles`;
  style.textContent = `
    .elvax-queue-map { display: flex; flex-direction: column; width: 100%; height: ${MIN_WIDGET_HEIGHT}px; min-height: ${MIN_WIDGET_HEIGHT}px; max-height: ${MIN_WIDGET_HEIGHT}px; box-sizing: border-box; overflow: hidden; padding: 9px; color: var(--fg-color, #eee); background: var(--comfy-input-bg, #222); font: 12px/1.4 sans-serif; }
    .elvax-queue-map__header { display: flex; flex: 0 0 auto; flex-direction: column; gap: 7px; margin: 0 2px 5px; padding: 2px 0 9px; border-bottom: 1px solid var(--border-color, #444); }
    .elvax-queue-map__heading, .elvax-queue-map__controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .elvax-queue-map__heading { justify-content: flex-start; gap: 6px; font-size: 14px; line-height: 1.25; font-weight: 600; white-space: nowrap; }
    .elvax-queue-map__title { margin: 0; font: inherit; }
    .elvax-queue-map__count { font-variant-numeric: tabular-nums; }
    .elvax-queue-map__state { color: var(--descrip-text, #aaa); }
    .elvax-queue-map__queue-status { min-width: 0; overflow: hidden; color: var(--descrip-text, #aaa); text-overflow: ellipsis; white-space: nowrap; }
    .elvax-queue-map__pause { flex: 0 0 auto; padding: 5px 11px; border: 1px solid #405d73; border-radius: 6px; color: #d9edff; background: #243849; font-weight: 600; white-space: nowrap; cursor: pointer; }
    .elvax-queue-map__pause:hover:not(:disabled) { border-color: #85b9e8; color: #c6e4ff; }
    .elvax-queue-map__pause:disabled { opacity: .55; cursor: wait; }
    .elvax-queue-map__list { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
    .elvax-queue-map__item { padding: 8px 2px; border-top: 1px solid var(--border-color, #444); }
    .elvax-queue-map__item-header { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
    .elvax-queue-map__state-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #999; }
    .elvax-queue-map__state-dot--running { background: #76cf76; }
    .elvax-queue-map__number { font-weight: 600; }
    .elvax-queue-map__cancel { margin-left: auto; padding: 3px 8px; border: 1px solid var(--border-color, #555); border-radius: 5px; color: var(--fg-color, #eee); background: transparent; cursor: pointer; }
    .elvax-queue-map__cancel:hover { border-color: #d66; color: #ffb0b0; }
    .elvax-queue-map__cancel:disabled { opacity: .55; cursor: wait; }
    .elvax-queue-map__body { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; }
    .elvax-queue-map__thumb { display: grid; width: 68px; height: 60px; place-items: center; overflow: hidden; border-radius: 4px; color: #aaa; background: #181818; font-size: 10px; text-align: center; }
    .elvax-queue-map__thumb img { width: 100%; height: 100%; object-fit: contain; }
    .elvax-queue-map__label { margin: 0 0 2px; color: var(--descrip-text, #aaa); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
    .elvax-queue-map__prompt { display: -webkit-box; overflow: hidden; color: var(--fg-color, #ddd); -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow-wrap: anywhere; }
    .elvax-queue-map__empty, .elvax-queue-map__error { padding: 14px 4px; color: var(--descrip-text, #aaa); }
    .elvax-queue-map__error { flex: 0 0 auto; max-height: 42px; overflow: auto; color: #ffaaaa; }
  `;
  document.head.append(style);
}

function createImageThumbnail(image) {
  const container = el("div", "elvax-queue-map__thumb", "No image");
  if (!image) return container;

  container.textContent = "";
  const thumbnail = document.createElement("img");
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  thumbnail.src = api.apiURL(`/view?${query.toString()}`);
  thumbnail.alt = image.filename;
  thumbnail.onerror = () => {
    container.textContent = "Image unavailable";
  };
  container.append(thumbnail);
  return container;
}

function createItem(item, view, order) {
  const row = el("article", "elvax-queue-map__item");
  const header = el("div", "elvax-queue-map__item-header");
  const dot = el("span", `elvax-queue-map__state-dot${item.state === "Running" ? " elvax-queue-map__state-dot--running" : ""}`);
  dot.setAttribute("aria-hidden", "true");
  header.append(dot, el("span", "elvax-queue-map__number", `#${order}`), el("span", "elvax-queue-map__state", item.state));

  const isPaused = item.state === "Paused";
  const cancel = el("button", "elvax-queue-map__cancel", isPaused ? "Remove" : "Cancel");
  cancel.type = "button";
  cancel.addEventListener("pointerdown", (event) => event.stopPropagation());
  cancel.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const confirmed = app.extensionManager?.dialog?.confirm
      ? await app.extensionManager.dialog.confirm({
          title: isPaused ? "Remove paused item?" : "Cancel queue item?",
          message: `${isPaused ? "Remove" : "Cancel"} #${order}?`,
        })
      : window.confirm(`${isPaused ? "Remove" : "Cancel"} #${order}?`);
    if (!confirmed) return;

    cancel.disabled = true;
    cancel.textContent = isPaused ? "Removing…" : "Cancelling…";
    try {
      if (isPaused) {
        await removePausedJob(item.job, view);
        return;
      }
      const response = await api.fetchApi(`/api/jobs/${encodeURIComponent(item.promptId)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
      app.extensionManager?.toast?.add({
        severity: "info",
        summary: "Cancel requested",
        detail: `Queue #${order}`,
        life: 2500,
      });
      view.signature = null;
      refreshQueue();
    } catch (error) {
      cancel.disabled = false;
      cancel.textContent = isPaused ? "Remove" : "Cancel";
      app.extensionManager?.toast?.add({
        severity: "error",
        summary: "Could not cancel queue item",
        detail: error.message || "ComfyUI request failed.",
        life: 4000,
      });
    }
  });
  header.append(cancel);

  const body = el("div", "elvax-queue-map__body");
  const image = findFirstImage(item.prompt, item.extraData);
  const details = document.createElement("div");
  const promptLabel = el("div", "elvax-queue-map__label", "First prompt");
  const prompt = findFirstPrompt(item.prompt, item.extraData);
  const promptText = el("div", "elvax-queue-map__prompt", prompt || "Prompt unavailable");
  details.append(promptLabel, promptText);
  body.append(createImageThumbnail(image), details);
  row.append(header, body);
  return row;
}

function renderView(view, items) {
  const signature = JSON.stringify(items.map((item) => [item.promptId, item.state]));
  if (signature === view.signature) return;
  view.signature = signature;
  const scrollTop = view.list.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    fragment.append(el("div", "elvax-queue-map__empty", "No queued or running items."));
  } else {
    items.forEach((item, index) => fragment.append(createItem(item, view, index + 1)));
  }
  view.list.replaceChildren(fragment);
  view.list.scrollTop = scrollTop;
  view.count.textContent = String(items.length);
}

async function refreshQueue() {
  if (refreshInProgress || nodeViews.size === 0) return;
  refreshInProgress = true;
  try {
    await queueDbReady;
    const response = await api.fetchApi("/queue");
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const queue = await response.json();
    serverQueueItems = [
      ...(queue.queue_running || []).map((tuple) => queueItem(tuple, "Running")),
      ...(queue.queue_pending || []).slice().sort((a, b) => a[0] - b[0])
        .map((tuple) => queueItem(tuple, "Queued")),
    ];
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      view.error.style.display = "none";
    }
    renderQueueViews();
  } catch (error) {
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      view.error.textContent = `Could not load queue: ${error.message || "request failed"}`;
      view.error.style.display = "block";
    }
  } finally {
    refreshInProgress = false;
  }
}

function renderQueueViews() {
  const items = [
    ...serverQueueItems,
    ...queueState.jobs.map((job) => ({
      promptId: job.promptId || job.key,
      prompt: job.prompt || {},
      extraData: { extra_pnginfo: { workflow: job.workflow } },
      state: "Paused",
      job,
    })),
  ];
  updateAllQueueControls();
  for (const view of nodeViews) {
    if (view.root.isConnected) renderView(view, items);
  }
}

function onQueueWheel(event) {
  if (!(event.target instanceof Element)) return;
  const root = event.target.closest(".elvax-queue-map") ||
    event.target.closest(".lg-node")?.querySelector(".elvax-queue-map");
  if (!root) return;
  for (const view of nodeViews) {
    if (view.root !== root) continue;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.list.clientHeight : 1;
    view.list.scrollTop += event.deltaY * unit;
    return;
  }
}

function startPolling() {
  if (pollTimer) return;
  addStyles();
  refreshQueue();
  pollTimer = setInterval(refreshQueue, POLL_INTERVAL_MS);
  api.addEventListener("status", onStatus);
  document.addEventListener("wheel", onQueueWheel, { capture: true, passive: false });
}

function stopPolling() {
  if (nodeViews.size) return;
  clearInterval(pollTimer);
  clearTimeout(refreshTimer);
  pollTimer = null;
  serverQueueItems = [];
  api.removeEventListener("status", onStatus);
  document.removeEventListener("wheel", onQueueWheel, true);
}

function onStatus() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshQueue, 150);
}

function installNode(node) {
  if (node.__elvaxQueueReferenceMapInstalled) return;
  node.__elvaxQueueReferenceMapInstalled = true;

  const root = document.createElement("div");
  root.className = "elvax-queue-map";
  const header = el("div", "elvax-queue-map__header");
  const heading = el("div", "elvax-queue-map__heading");
  const title = el("h2", "elvax-queue-map__title", "Generations in queue :");
  const count = el("span", "elvax-queue-map__count", "0");
  heading.append(title, count);
  const controls = el("div", "elvax-queue-map__controls");
  const queueStatus = el("span", "elvax-queue-map__queue-status");
  const pauseButton = el("button", "elvax-queue-map__pause", "Pause Queue");
  pauseButton.type = "button";
  pauseButton.title = "Pause pending jobs and save them locally. The running job will finish.";
  pauseButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  pauseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleQueue(view);
  });
  controls.append(queueStatus, pauseButton);
  header.append(heading, controls);
  const list = document.createElement("div");
  list.className = "elvax-queue-map__list";
  const error = el("div", "elvax-queue-map__error", "");
  error.style.display = "none";
  root.append(header, list, error);

  const widget = node.addDOMWidget("queue_reference_map", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_WIDGET_HEIGHT,
  });
  widget.computeLayoutSize = () => ({
    minHeight: MIN_WIDGET_HEIGHT,
    minWidth: 250,
  });
  const naturalSize = node.computeSize();
  const nodeChromeHeight = Math.max(0, naturalSize[1] - MIN_WIDGET_HEIGHT);
  node.min_size = [Math.max(node.min_size?.[0] || 0, 280), Math.max(node.min_size?.[1] || 0, MIN_WIDGET_HEIGHT + nodeChromeHeight)];
  if ((node.size?.[1] || 0) < MIN_WIDGET_HEIGHT + nodeChromeHeight) {
    node.setSize([Math.max(node.size?.[0] || 280, 280), MIN_WIDGET_HEIGHT + nodeChromeHeight]);
  }

  const view = { root, header, list, count, error, pauseButton, queueStatus, signature: null };
  nodeViews.add(view);
  renderQueueViews();
  startPolling();

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    nodeViews.delete(view);
    stopPolling();
    return originalRemoved?.apply(this, args);
  };
}

app.registerExtension({
  name: "elvax.queue-reference-map",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      installNode(this);
      return result;
    };
  },
});
