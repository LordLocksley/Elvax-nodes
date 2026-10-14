import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxJSONPromptBuilder";
const DEFAULT_NODE_WIDTH = 900;
const TYPES = ["string", "number", "boolean", "object", "array", "json"];
const HIDDEN_FIELDS_KEY = "__elvax_json_prompt_builder__";
const FIELD_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#fca5a5", "#fdba74", "#fcd34d", "#fde047", "#bef264", "#86efac", "#6ee7b7", "#5eead4",
  "#67e8f9", "#7dd3fc", "#93c5fd", "#a5b4fc", "#c4b5fd", "#d8b4fe", "#f0abfc", "#f9a8d4",
];

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizeItem(item) {
  const type = TYPES.includes(item?.type) ? item.type : "string";
  let value = item?.value ?? "";
  if (type === "object") value = Array.isArray(value) ? value.map(normalizeField) : [];
  if (type === "array") value = Array.isArray(value) ? value.map(normalizeItem) : [];
  return { type, value, expanded: Boolean(item?.expanded), hidden: Boolean(item?.hidden), color: FIELD_COLORS.includes(item?.color) ? item.color : "" };
}

function normalizeField(field) {
  const normalized = normalizeItem(field);
  return { key: String(field?.key ?? ""), ...normalized };
}

function parseBuilderData(value) {
  try {
    const saved = JSON.parse(value || "[]");
    if (Array.isArray(saved)) {
      return {
        rows: saved.map(normalizeField),
        keys: { video_count: "video_count", video_duration: "video_duration" },
        wrapValues: true,
      };
    }
    if (Array.isArray(saved?.fields)) {
      return {
        rows: saved.fields.map(normalizeField),
        keys: {
          video_count: String(saved.keys?.video_count ?? "video_count"),
          video_duration: String(saved.keys?.video_duration ?? "video_duration"),
        },
        wrapValues: saved.wrapValues == null ? true : Boolean(saved.wrapValues),
        fixedValues: saved.fixedValues && typeof saved.fixedValues === "object" ? saved.fixedValues : null,
      };
    }
    return { rows: [], keys: { video_count: "video_count", video_duration: "video_duration" }, wrapValues: true };
  } catch {
    return { rows: [], keys: { video_count: "video_count", video_duration: "video_duration" }, wrapValues: true };
  }
}

function isSerializedBuilderData(value) {
  try {
    const saved = JSON.parse(value);
    return Array.isArray(saved) || Array.isArray(saved?.fields);
  } catch {
    return false;
  }
}

function fixedValueText(key, value) {
  const text = String(value ?? "");
  const valid = key === "video_count" ? /^\d*$/.test(text) : /^\d*(?:\.\d*)?$/.test(text);
  return valid ? text : "";
}

function fieldFromValue(key, value, path, hiddenFields, fieldColors = {}) {
  const hidden = hiddenFields.has(path);
  const color = FIELD_COLORS.includes(fieldColors[path]) ? fieldColors[path] : "";
  if (Array.isArray(value)) {
    return { key, type: "array", value: value.map((item, index) => itemFromValue(item, `${path}/${index}`, hiddenFields, fieldColors)), expanded: false, hidden, color };
  }
  if (value !== null && typeof value === "object") {
    return {
      key,
      type: "object",
      value: Object.entries(value).map(([childKey, childValue]) => fieldFromValue(childKey, childValue, `${path}/${pointerSegment(childKey)}`, hiddenFields, fieldColors)),
      expanded: false,
      hidden,
      color,
    };
  }
  if (value === null) return { key, type: "json", value: "null", expanded: false, hidden, color };
  return { key, type: typeof value, value: typeof value === "boolean" ? value : String(value), expanded: false, hidden, color };
}

function itemFromValue(value, path, hiddenFields, fieldColors = {}) {
  const field = fieldFromValue("", value, path, hiddenFields, fieldColors);
  return { type: field.type, value: field.value, expanded: field.expanded, hidden: field.hidden, color: field.color };
}

function valueFromRow(row, label, pointer = "", includeHidden = false, hiddenFields = null, fieldColors = null) {
  if (row.type === "number") {
    const value = JSON.parse(String(row.value));
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Field "${label}" must contain a finite number.`);
    }
    return value;
  }
  if (row.type === "boolean") return row.value === true || String(row.value).toLowerCase() === "true";
  if (row.type === "json") return JSON.parse(row.value);
  if (row.type === "object") return objectFromRows(row.value, label, pointer, includeHidden, hiddenFields, fieldColors);
  if (row.type === "array") {
    return row.value.flatMap((item, index) => {
      const itemPointer = `${pointer}/${index}`;
      if (item.hidden) hiddenFields?.push(itemPointer);
      if (FIELD_COLORS.includes(item.color) && fieldColors) fieldColors[itemPointer] = item.color;
      if (item.hidden && !includeHidden) return [];
      return [valueFromRow(item, `${label}[${index + 1}]`, itemPointer, includeHidden, hiddenFields, fieldColors)];
    });
  }
  return String(row.value ?? "");
}

function objectFromRows(rows, path = "root", pointer = "", includeHidden = false, hiddenFields = null, fieldColors = null) {
  return Object.fromEntries(rows.flatMap((row) => {
    const key = String(row.key || "").trim();
    if (!key) return [];
    const childPointer = `${pointer}/${pointerSegment(key)}`;
    if (row.hidden) hiddenFields?.push(childPointer);
    if (FIELD_COLORS.includes(row.color) && fieldColors) fieldColors[childPointer] = row.color;
    if (row.hidden && !includeHidden) return [];
    return [[key, valueFromRow(row, `${path}.${key}`, childPointer, includeHidden, hiddenFields, fieldColors)]];
  }));
}

function installNode(node) {
  if (node.__elvaxJSONPromptBuilderInstalled) return;
  const dataWidget = node.widgets?.find((widget) => widget.name === "fields_json");
  const videoCountWidget = node.widgets?.find((widget) => widget.name === "video_count");
  const videoDurationWidget = node.widgets?.find((widget) => widget.name === "video_duration");
  if (!dataWidget || !videoCountWidget || !videoDurationWidget) return;
  node.__elvaxJSONPromptBuilderInstalled = true;

  const savedData = parseBuilderData(dataWidget.value);
  const rows = savedData.rows;
  let fieldKeys = savedData.keys;
  let wrapValues = savedData.wrapValues;
  const root = document.createElement("div");
  let colorOverlay = null;
  root.className = "elvax-json-builder";
  root.style.cssText = "width:100%;box-sizing:border-box;padding:8px;color:var(--fg-color,#ddd);font:12px/1.4 sans-serif;";

  const style = document.createElement("style");
  style.textContent = `
    .elvax-json-builder__head,.elvax-json-builder__row,.elvax-json-builder__fixed-row { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(48px,74px) minmax(0,1.5fr) max-content; gap:5px; align-items:center; }
    .elvax-json-builder__head { padding:0 1px 4px; color:var(--descrip-text,#999); font-size:10px; }
    .elvax-json-builder__row { margin-bottom:5px; align-items:start; }
    .elvax-json-builder__row--colored > :not(.elvax-json-builder__actions) { border-color:var(--elvax-field-color); background:var(--elvax-field-background); }
    .elvax-json-builder__fixed-fields { display:grid; gap:5px; margin-bottom:10px; }
    .elvax-json-builder input,.elvax-json-builder select,.elvax-json-builder button,.elvax-json-builder textarea { min-width:0; box-sizing:border-box; height:27px; border:1px solid var(--border-color,#555); border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); font:inherit; }
    .elvax-json-builder input { width:100%; padding:4px 6px; }
    .elvax-json-builder select { width:100%; padding:2px 3px; }
    .elvax-json-builder select option { background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); }
    .elvax-json-builder textarea { width:100%; min-height:27px; padding:4px 6px; line-height:17px; }
    .elvax-json-builder__value-textarea { display:block; resize:none; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; white-space:pre; }
    .elvax-json-builder__value-textarea::-webkit-scrollbar { display:none; }
    .elvax-json-builder__value-textarea--wrap { overflow-x:hidden; overflow-wrap:anywhere; white-space:pre-wrap; }
    .elvax-json-builder button { padding:2px 5px; cursor:pointer; }
    .elvax-json-builder button:hover { border-color:#888; background:#383838; }
    .elvax-json-builder__action-button { border-color:#55728f !important; background:#34485a !important; }
    .elvax-json-builder__action-button:hover { border-color:#7899ba !important; background:#405b73 !important; }
    .elvax-json-builder__action-button--add { border-color:#61785e !important; background:#3c4939 !important; }
    .elvax-json-builder__action-button--add:hover { border-color:#829d7e !important; background:#4a5b46 !important; }
    .elvax-json-builder__fixed-actions { grid-column:3 / 5; display:flex; align-items:center; gap:6px; margin-left:10px; }
    .elvax-json-builder__fixed-actions button { flex:0 0 auto; white-space:nowrap; }
    .elvax-json-builder__wrap-toggle { grid-column:3 / 5; justify-self:start; margin-left:10px; white-space:nowrap; }
    .elvax-json-builder .elvax-json-builder__wrap-toggle { appearance:none; display:inline-flex; align-items:center; justify-content:center; width:max-content; min-width:0; padding:3px 9px; line-height:normal; box-shadow:none; }
    .elvax-json-builder .elvax-json-builder__wrap-toggle::before,.elvax-json-builder .elvax-json-builder__wrap-toggle::after { content:none !important; display:none !important; }
    .elvax-json-builder__wrap-toggle[data-active="false"] { border-color:#8c5656 !important; background:#5b3838 !important; }
    .elvax-json-builder__wrap-toggle[data-active="false"]:hover { border-color:#b67575 !important; background:#704343 !important; }
    .elvax-json-builder__wrap-toggle[data-active="true"] { border-color:#638b6d !important; background:#385741 !important; }
    .elvax-json-builder__wrap-toggle[data-active="true"]:hover { border-color:#83ad8d !important; background:#47694f !important; }
    .elvax-json-builder__actions { display:flex; justify-content:flex-end; gap:4px; }
    .elvax-json-builder__actions .elvax-json-builder__icon-button { display:grid; width:26px; height:26px; flex:0 0 26px; place-items:center; padding:0; border:1px solid var(--border-color,#555); border-radius:6px; background:transparent; color:var(--descrip-text,#aaa); transition:color 120ms,border-color 120ms,background-color 120ms,transform 120ms; }
    .elvax-json-builder__icon-button svg { width:14px; height:14px; }
    .elvax-json-builder__icon-button:hover { transform:translateY(-1px); border-color:#888 !important; background:#3b3b3b !important; color:#fff !important; }
    .elvax-json-builder__icon-button:disabled { opacity:.35; cursor:default; transform:none; }
    .elvax-json-builder__icon-button--remove:hover { border-color:#a85d5d !important; background:#492d2d !important; color:#ffbaba !important; }
    .elvax-json-builder__row--hidden > :not(.elvax-json-builder__actions) { opacity:.42; }
    .elvax-json-builder__container-toggle { width:100%; overflow:hidden; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
    .elvax-json-builder__nested { margin:2px 0 8px 12px; padding-left:9px; border-left:1px solid var(--border-color,#555); }
    .elvax-json-builder__nested-add { margin:0 0 5px; padding:3px 9px !important; }
    .elvax-json-builder__toolbar { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; padding-bottom:8px; }
    .elvax-json-builder__toolbar button { padding:3px 9px; }
    .elvax-json-builder__empty { margin:2px 0 7px; color:var(--descrip-text,#999); }
    .elvax-json-builder__overlay { position:fixed; inset:0; z-index:10000; display:grid; place-items:center; background:#0009; }
    .elvax-json-builder__dialog { display:flex; width:min(560px,80vw); height:min(440px,75vh); flex-direction:column; gap:8px; padding:12px; border:1px solid #555; border-radius:7px; background:var(--comfy-menu-bg,#292929); box-shadow:0 8px 30px #0009; }
    .elvax-json-builder__dialog textarea { flex:1; min-height:0; resize:none; padding:8px; border:1px solid #555; border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); font:12px/1.5 monospace; }
    .elvax-json-builder__dialog-actions { display:flex; justify-content:flex-end; gap:6px; }
    .elvax-json-builder__dialog.elvax-json-builder__color-dialog { width:min(340px,90vw); height:auto; color:var(--fg-color,#ddd); font:12px/1.4 sans-serif; }
    .elvax-json-builder__color-grid { display:grid; grid-template-columns:repeat(8,minmax(0,1fr)); gap:6px; }
    .elvax-json-builder__color-swatch { width:100%; height:30px; padding:0; border:2px solid transparent; border-radius:5px; cursor:pointer; }
    .elvax-json-builder__color-swatch:hover,.elvax-json-builder__color-swatch:focus-visible { outline:2px solid #fff; outline-offset:1px; }
    .elvax-json-builder__color-swatch[aria-pressed="true"] { border-color:#fff; box-shadow:inset 0 0 0 2px #202020; }
    .elvax-json-builder__color-dialog .elvax-json-builder__dialog-actions button { height:27px; padding:3px 9px; border:1px solid #555; border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); cursor:pointer; }
    .elvax-json-builder__color-dialog .elvax-json-builder__dialog-actions button[aria-pressed="true"] { border-color:#aaa; }
  `;
  root.append(style);

  const fixedControls = document.createElement("div");
  fixedControls.className = "elvax-json-builder__fixed-fields";
  const fixedInputs = new Map();
  for (const [key, widget] of [
    ["video_count", videoCountWidget],
    ["video_duration", videoDurationWidget],
  ]) {
    const line = document.createElement("div");
    line.className = "elvax-json-builder__fixed-row";
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.value = fieldKeys[key];
    keyInput.placeholder = key;
    keyInput.title = `JSON key for ${key}`;
    keyInput.setAttribute("aria-label", `${key} JSON key`);
    keyInput.addEventListener("input", () => {
      fieldKeys[key] = keyInput.value;
      input.title = `Value for ${keyInput.value || key}`;
      sync();
    });
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = key === "video_count" ? "numeric" : "decimal";
    input.value = fixedValueText(key, widget.value);
    input.placeholder = "value";
    input.title = `Value for ${fieldKeys[key] || key}`;
    widget.value = input.value;
    input.setAttribute("aria-label", key);
    input.addEventListener("keydown", (event) => {
      if (["-", "+", "e", "E"].includes(event.key)
        || key === "video_count" && event.key === ".") event.preventDefault();
    });
    input.addEventListener("input", () => {
      input.value = fixedValueText(key, input.value);
      widget.value = input.value;
      widget.callback?.(widget.value, app.canvas, node);
      sync();
    });
    line.append(keyInput, input);
    fixedControls.append(line);
    fixedInputs.set(key, { key: keyInput, value: input });
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
  }

  const list = document.createElement("div");
  let measuredRootWidth = 0;
  const rootResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width || 0;
    if (!width || Math.abs(width - measuredRootWidth) < 1) return;
    measuredRootWidth = width;
    requestAnimationFrame(() => {
      list.querySelectorAll(".elvax-json-builder__value-textarea--wrap").forEach((value) => value.__elvaxResize?.());
      updateMinimumNodeSize();
    });
  });
  rootResizeObserver.observe(root);
  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    rootResizeObserver.disconnect();
    colorOverlay?.remove();
    colorOverlay = null;
    return originalRemoved?.apply(this, args);
  };
  const toolbar = document.createElement("div");
  toolbar.className = "elvax-json-builder__toolbar";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "elvax-json-builder__action-button elvax-json-builder__action-button--add";
  addButton.textContent = "+ Add field";
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "elvax-json-builder__action-button";
  loadButton.textContent = "Load JSON";
  loadButton.title = "Load a JSON object from a file";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "elvax-json-builder__action-button";
  saveButton.textContent = "Save JSON";
  saveButton.title = "Download the current fields as a JSON file";
  const fixedActions = document.createElement("div");
  fixedActions.className = "elvax-json-builder__fixed-actions";
  fixedActions.append(loadButton, saveButton);
  fixedControls.firstElementChild.append(fixedActions);
  const wrapToggle = document.createElement("button");
  wrapToggle.type = "button";
  wrapToggle.className = "elvax-json-builder__action-button elvax-json-builder__wrap-toggle";
  wrapToggle.title = "Toggle wrapping for string Value fields only";
  const updateWrapToggle = () => {
    wrapToggle.textContent = "Wrap text";
    wrapToggle.dataset.active = String(wrapValues);
    wrapToggle.setAttribute("aria-label", `Wrap text ${wrapValues ? "on" : "off"}`);
    wrapToggle.title = `Wrap text is ${wrapValues ? "on" : "off"}`;
  };
  updateWrapToggle();
  fixedControls.children[1].append(wrapToggle);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.style.display = "none";
  toolbar.append(addButton, fileInput);

  const contentHeight = () => Math.ceil(fixedControls.offsetHeight + list.offsetHeight + toolbar.offsetHeight + 26);
  const serializeBuilderState = () => JSON.stringify({
    fields: rows,
    keys: fieldKeys,
    wrapValues,
    fixedValues: {
      video_count: videoCountWidget.value,
      video_duration: videoDurationWidget.value,
    },
  });
  const sync = () => {
    dataWidget.value = serializeBuilderState();
    dataWidget.callback?.(dataWidget.value, app.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
  };
  const fixedFields = () => {
    const fields = {};
    const count = String(videoCountWidget.value ?? "").trim();
    const duration = String(videoDurationWidget.value ?? "").trim();
    if (count) {
      const value = Number(count);
      if (!Number.isInteger(value) || value < 0) throw new Error("video_count must be a non-negative integer.");
      const key = String(fieldKeys.video_count || "").trim();
      if (value > 0 && key) fields[key] = value;
    }
    if (duration) {
      const value = Number(duration);
      if (!Number.isFinite(value) || value < 0) throw new Error("video_duration must be a non-negative number.");
      const key = String(fieldKeys.video_duration || "").trim();
      if (value > 0 && key) fields[key] = value;
    }
    return fields;
  };
  const jsonObject = (includeHidden = false, hiddenFields = null, fieldColors = null) => {
    const fields = objectFromRows(rows, "root", "", includeHidden, hiddenFields, fieldColors);
    const fixed = fixedFields();
    for (const key of Object.keys(fixed)) delete fields[key];
    return { ...fixed, ...fields };
  };
  const toast = (severity, summary, detail) => {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 3000 });
  };

  function openJsonEditor(row) {
    const overlay = document.createElement("div");
    overlay.className = "elvax-json-builder__overlay";
    const dialog = document.createElement("section");
    dialog.className = "elvax-json-builder__dialog";
    const title = document.createElement("strong");
    title.textContent = `Edit JSON value${row.key ? ` — ${row.key}` : ""}`;
    const editor = document.createElement("textarea");
    editor.spellcheck = false;
    editor.value = String(row.value || "");
    const actions = document.createElement("div");
    actions.className = "elvax-json-builder__dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", () => {
      row.value = editor.value;
      sync();
      render();
      overlay.remove();
    });
    overlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    actions.append(cancel, save);
    dialog.append(title, editor, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    editor.focus();
  }

  function setType(row, type) {
    row.type = type;
    row.value = type === "boolean" ? false
      : type === "object" || type === "array" ? [] : "";
    row.expanded = type === "object" || type === "array";
  }

  function makeIcon(path) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function openFieldColor(row) {
    colorOverlay?.remove();
    const overlay = document.createElement("div");
    overlay.className = "elvax-json-builder__overlay";
    colorOverlay = overlay;
    const dialog = document.createElement("section");
    dialog.className = "elvax-json-builder__dialog elvax-json-builder__color-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Choose field color");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("strong");
    title.textContent = `Field color${row.key ? ` — ${row.key}` : ""}`;
    const palette = document.createElement("div");
    palette.className = "elvax-json-builder__color-grid";
    const close = () => {
      overlay.remove();
      if (colorOverlay === overlay) colorOverlay = null;
    };
    const choose = (color) => {
      row.color = color;
      sync();
      render();
      close();
    };
    for (const [index, color] of FIELD_COLORS.entries()) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "elvax-json-builder__color-swatch";
      swatch.style.backgroundColor = color;
      swatch.title = `Color ${index + 1}: ${color}`;
      swatch.setAttribute("aria-label", swatch.title);
      swatch.setAttribute("aria-pressed", String(row.color === color));
      swatch.addEventListener("click", () => choose(color));
      palette.append(swatch);
    }
    const actions = document.createElement("div");
    actions.className = "elvax-json-builder__dialog-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "None";
    reset.title = "Remove this field's color";
    reset.setAttribute("aria-pressed", String(!row.color));
    reset.addEventListener("click", () => choose(""));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Close";
    cancel.addEventListener("click", close);
    actions.append(reset, cancel);
    dialog.append(title, palette, actions);
    overlay.append(dialog);
    overlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    document.body.append(overlay);
    palette.querySelector('[aria-pressed="true"]')?.focus();
    if (!overlay.contains(document.activeElement)) reset.focus();
  }

  function renderFields(target, fields, arrayItems = false, showHeader = false, inheritedHidden = false) {
    target.replaceChildren();
    if (showHeader) {
      const header = document.createElement("div");
      header.className = "elvax-json-builder__head";
      for (const label of ["Key", "Type", "Value", ""]) {
        const cell = document.createElement("span");
        cell.textContent = label;
        header.append(cell);
      }
      target.append(header);
    }
    if (!fields.length) {
      const empty = document.createElement("div");
      empty.className = "elvax-json-builder__empty";
      empty.textContent = showHeader ? "No fields yet. Add a field to start building your JSON." : "Empty";
      target.append(empty);
    }

    fields.forEach((row, index) => {
      const line = document.createElement("div");
      const rowHidden = inheritedHidden || row.hidden;
      line.className = `elvax-json-builder__row${rowHidden ? " elvax-json-builder__row--hidden" : ""}`;
      if (FIELD_COLORS.includes(row.color)) {
        line.classList.add("elvax-json-builder__row--colored");
        line.style.setProperty("--elvax-field-color", row.color);
        line.style.setProperty("--elvax-field-background", `${row.color}26`);
      }
      let key;
      if (arrayItems) {
        key = document.createElement("span");
        key.textContent = `Item ${index + 1}`;
        key.style.cssText = "overflow:hidden;color:var(--descrip-text,#aaa);text-overflow:ellipsis;white-space:nowrap;";
      } else {
        key = document.createElement("input");
        key.placeholder = "field_name";
        key.value = row.key;
        key.disabled = rowHidden;
        key.setAttribute("aria-label", "Field key");
        key.addEventListener("input", () => { row.key = key.value; sync(); });
      }

      const type = document.createElement("select");
      type.setAttribute("aria-label", "Field type");
      for (const optionType of TYPES) {
        const option = document.createElement("option");
        option.value = optionType;
        option.textContent = optionType;
        type.append(option);
      }
      type.value = row.type;
      type.disabled = rowHidden;
      type.addEventListener("change", () => {
        setType(row, type.value);
        sync();
        render();
      });

      let value;
      if (row.type === "boolean") {
        value = document.createElement("select");
        for (const bool of [false, true]) {
          const option = document.createElement("option");
          option.value = String(bool);
          option.textContent = String(bool);
          value.append(option);
        }
        value.value = String(row.value === true || String(row.value) === "true");
        value.addEventListener("change", () => { row.value = value.value === "true"; sync(); });
      } else if (row.type === "json") {
        value = document.createElement("button");
        value.type = "button";
        value.textContent = "Edit JSON…";
        value.title = "Edit a raw JSON value";
        value.addEventListener("click", () => openJsonEditor(row));
      } else if (row.type === "object" || row.type === "array") {
        value = document.createElement("button");
        value.type = "button";
        value.className = "elvax-json-builder__container-toggle";
        const childCount = row.value.length;
        const itemLabel = row.type === "object" ? "field" : "item";
        value.textContent = `${row.expanded ? "▾" : "▸"} ${childCount} ${itemLabel}${childCount === 1 ? "" : "s"}`;
        value.title = row.expanded ? "Collapse children" : "Expand children";
        value.addEventListener("click", () => {
          row.expanded = !row.expanded;
          sync();
          render();
        });
      } else if (row.type === "string") {
        value = document.createElement("textarea");
        value.className = `elvax-json-builder__value-textarea${wrapValues ? " elvax-json-builder__value-textarea--wrap" : ""}`;
        value.rows = 1;
        value.wrap = wrapValues ? "soft" : "off";
        value.value = String(row.value ?? "");
        value.setAttribute("aria-label", "Field value");
        const resize = () => {
          if (wrapValues && !value.clientWidth) return;
          value.style.height = "27px";
          if (wrapValues) {
            value.style.height = `${Math.max(27, Math.min(value.scrollHeight, 160))}px`;
            value.style.overflowY = value.scrollHeight > 160 ? "auto" : "hidden";
          } else {
            value.style.overflowY = "hidden";
          }
        };
        value.__elvaxResize = resize;
        value.addEventListener("input", () => {
          row.value = value.value;
          sync();
          resize();
          requestAnimationFrame(updateMinimumNodeSize);
        });
        requestAnimationFrame(resize);
      } else {
        value = document.createElement("input");
        value.placeholder = row.type === "number" ? "e.g. 3" : "value";
        value.value = String(row.value ?? "");
        value.setAttribute("aria-label", "Field value");
        value.addEventListener("input", () => { row.value = value.value; sync(); });
      }
      value.disabled = rowHidden;

      const actions = document.createElement("div");
      actions.className = "elvax-json-builder__actions";
      const move = (label, icon, delta, disabled) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "elvax-json-builder__icon-button";
        button.innerHTML = icon;
        button.disabled = disabled;
        button.title = label === "↑" ? "Move up" : "Move down";
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", () => {
          const targetIndex = index + delta;
          [fields[index], fields[targetIndex]] = [fields[targetIndex], fields[index]];
          sync();
          render();
        });
        return button;
      };
      actions.append(
        move("↑", makeIcon('<path d="m7 14 5-5 5 5"/>'), -1, index === 0 || rowHidden),
        move("↓", makeIcon('<path d="m7 10 5 5 5-5"/>'), 1, index === fields.length - 1 || rowHidden),
      );
      const color = document.createElement("button");
      color.type = "button";
      color.className = "elvax-json-builder__icon-button";
      color.innerHTML = makeIcon('<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.7 1.7 0 0 1 .8-3.3H17a4 4 0 0 0 4-4c0-4-4-7-9-7Z"/><circle cx="7.5" cy="10" r=".7"/><circle cx="11" cy="7" r=".7"/><circle cx="15.5" cy="8" r=".7"/>');
      color.title = "Choose field color";
      color.setAttribute("aria-label", color.title);
      color.disabled = inheritedHidden;
      if (row.color) color.style.color = row.color;
      color.addEventListener("click", () => openFieldColor(row));
      actions.append(color);
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "elvax-json-builder__icon-button";
      hide.innerHTML = makeIcon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>' + (row.hidden ? '<path d="m3 3 18 18"/>' : ""));
      hide.title = row.hidden ? "Show field" : "Hide field";
      hide.setAttribute("aria-label", hide.title);
      hide.setAttribute("aria-pressed", String(Boolean(row.hidden)));
      hide.disabled = inheritedHidden;
      hide.addEventListener("click", () => {
        row.hidden = !row.hidden;
        sync();
        render();
      });
      actions.append(hide);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "elvax-json-builder__icon-button elvax-json-builder__icon-button--remove";
      remove.innerHTML = makeIcon('<path d="m18 6-12 12M6 6l12 12"/>');
      remove.title = "Remove field";
      remove.setAttribute("aria-label", "Remove field");
      remove.disabled = rowHidden;
      remove.addEventListener("click", () => {
        fields.splice(index, 1);
        sync();
        render();
      });
      actions.append(remove);
      line.append(key, type, value, actions);
      target.append(line);

      if ((row.type === "object" || row.type === "array") && row.expanded) {
        const nested = document.createElement("div");
        nested.className = "elvax-json-builder__nested";
        const nestedFields = row.value;
        renderFields(nested, nestedFields, row.type === "array", false, rowHidden);
        const addChild = document.createElement("button");
        addChild.type = "button";
        addChild.className = "elvax-json-builder__nested-add elvax-json-builder__action-button elvax-json-builder__action-button--add";
        addChild.textContent = row.type === "object" ? "+ Add field" : "+ Add item";
        addChild.disabled = rowHidden;
        addChild.addEventListener("click", () => {
          nestedFields.push(row.type === "object"
            ? { key: "", type: "string", value: "", expanded: false, hidden: false, color: "" }
            : { type: "string", value: "", expanded: false, hidden: false, color: "" });
          sync();
          render();
        });
        nested.append(addChild);
        target.append(nested);
      }
    });
  }

  function render() {
    colorOverlay?.remove();
    colorOverlay = null;
    renderFields(list, rows, false, true);
    node.graph?.setDirtyCanvas(true, true);
    requestAnimationFrame(updateMinimumNodeSize);
  }

  addButton.addEventListener("click", () => {
    rows.push({ key: "", type: "string", value: "", expanded: false, hidden: false, color: "" });
    sync();
    render();
  });
  wrapToggle.addEventListener("click", () => {
    wrapValues = !wrapValues;
    updateWrapToggle();
    sync();
    render();
  });
  loadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("The file must contain a JSON object at its top level.");
      }
      const metadata = parsed[HIDDEN_FIELDS_KEY];
      const hasHiddenMetadata = metadata?.version === 1 && Array.isArray(metadata.hiddenFields);
      const hiddenFields = new Set(hasHiddenMetadata
        ? metadata.hiddenFields.filter((path) => typeof path === "string")
        : []);
      const fieldColors = hasHiddenMetadata && metadata.fieldColors && typeof metadata.fieldColors === "object"
        && !Array.isArray(metadata.fieldColors) ? metadata.fieldColors : {};
      const loadedObject = { ...parsed };
      if (hasHiddenMetadata) delete loadedObject[HIDDEN_FIELDS_KEY];
      for (const [key, widget, isValid] of [
        ["video_count", videoCountWidget, (value) => Number.isInteger(value) && value >= 0],
        ["video_duration", videoDurationWidget, (value) => Number.isFinite(value) && value >= 0],
      ]) {
        const jsonKey = String(fieldKeys[key] || "").trim();
        const value = !jsonKey || loadedObject[jsonKey] == null ? "" : String(loadedObject[jsonKey]);
        if (value && !isValid(Number(value))) throw new Error(`"${key}" must be a valid number.`);
        const normalized = fixedValueText(key, value);
        if (value && !normalized) throw new Error(`"${key}" has an invalid format.`);
        widget.value = normalized;
        fixedInputs.get(key).value.value = normalized;
        widget.callback?.(normalized, app.canvas, node);
      }
      const fixedKeys = new Set(Object.values(fieldKeys).map((key) => String(key || "").trim()).filter(Boolean));
      const loadedRows = Object.entries(loadedObject)
        .filter(([key]) => !fixedKeys.has(key))
        .map(([key, value]) => fieldFromValue(key, value, `/${pointerSegment(key)}`, hiddenFields, fieldColors));
      rows.splice(0, rows.length, ...loadedRows);
      sync();
      render();
      toast("success", "JSON loaded", `${loadedRows.length} fields imported.`);
    } catch (error) {
      toast("error", "Could not load JSON", error.message || "The file is not valid JSON.");
    }
  });
  saveButton.addEventListener("click", () => {
    try {
      const hiddenFields = [];
      const fieldColors = {};
      const savedObject = jsonObject(true, hiddenFields, fieldColors);
      if (hiddenFields.length || Object.keys(fieldColors).length) {
        if (Object.hasOwn(savedObject, HIDDEN_FIELDS_KEY)) {
          throw new Error(`Rename the field "${HIDDEN_FIELDS_KEY}" before saving field metadata.`);
        }
        savedObject[HIDDEN_FIELDS_KEY] = { version: 1, hiddenFields, fieldColors };
      }
      const json = JSON.stringify(savedObject, null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const download = document.createElement("a");
      download.href = url;
      const now = new Date();
      const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
        .map((value) => String(value).padStart(2, "0")).join("-");
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, "0")).join("-");
      const filename = `prompt_${date}_${time}-${String(now.getMilliseconds()).padStart(3, "0")}.json`;
      download.download = filename;
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("success", "JSON saved", `Downloaded as ${filename}.`);
    } catch (error) {
      toast("error", "Could not save JSON", error.message || "Check the field values.");
    }
  });

  for (const eventName of ["pointerdown", "pointermove", "contextmenu"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });
  root.append(fixedControls, list, toolbar);

  dataWidget.serializeValue = serializeBuilderState;
  dataWidget.hidden = true;
  dataWidget.type = "hidden";
  dataWidget.computeSize = () => [0, -4];
  const domWidget = node.addDOMWidget("json_prompt_builder", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getHeight: contentHeight,
    getMinHeight: contentHeight,
  });
  domWidget.computeLayoutSize = () => ({ minHeight: Math.max(50, contentHeight()), minWidth: 280 });

  function updateRootWidth() {
    const width = Math.max(0, (node.size?.[0] || 0) - 16);
    if (width) root.style.width = `${width}px`;
  }

  const originalResize = node.onResize;
  node.onResize = function (...args) {
    const result = originalResize?.apply(this, args);
    updateRootWidth();
    return result;
  };

  function updateMinimumNodeSize() {
    const widgetHeight = Math.max(50, contentHeight());
    const widgetTop = Number.isFinite(domWidget.last_y) && domWidget.last_y > 0
      ? domWidget.last_y
      : Math.max(0, (node.computeSize?.()[1] || widgetHeight) - widgetHeight);
    const minimumHeight = Math.ceil(widgetTop + widgetHeight + 10);
    node.min_size = [Math.max(node.min_size?.[0] || 0, 370), minimumHeight];
    if ((node.size?.[1] || 0) !== minimumHeight) {
      node.setSize([node.size?.[0] || DEFAULT_NODE_WIDTH, minimumHeight]);
    }
  }

  const initialSize = node.computeSize();
  node.setSize([Math.max(node.size?.[0] || 0, DEFAULT_NODE_WIDTH), initialSize[1]]);
  updateRootWidth();
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(() => {
      if (!isSerializedBuilderData(dataWidget.value) && isSerializedBuilderData(videoDurationWidget.value)) {
        const savedCount = fixedValueText("video_count", dataWidget.value);
        const savedDuration = fixedValueText("video_duration", videoCountWidget.value);
        dataWidget.value = videoDurationWidget.value;
        videoCountWidget.value = savedCount;
        videoDurationWidget.value = savedDuration;
        fixedInputs.get("video_count").value.value = savedCount;
        fixedInputs.get("video_duration").value.value = savedDuration;
      }
      const configuredData = parseBuilderData(dataWidget.value);
      rows.splice(0, rows.length, ...configuredData.rows);
      fieldKeys = configuredData.keys;
      wrapValues = configuredData.wrapValues;
      updateWrapToggle();
      for (const key of ["video_count", "video_duration"]) {
        fixedInputs.get(key).key.value = fieldKeys[key];
        if (configuredData.fixedValues && Object.hasOwn(configuredData.fixedValues, key)) {
          const value = fixedValueText(key, configuredData.fixedValues[key]);
          const widget = key === "video_count" ? videoCountWidget : videoDurationWidget;
          widget.value = value;
          fixedInputs.get(key).value.value = value;
        }
      }
      render();
      updateRootWidth();
      requestAnimationFrame(updateMinimumNodeSize);
    });
    return result;
  };
  render();
}

app.registerExtension({
  name: "elvax.json-prompt-builder",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) installNode(node);
  },
});
