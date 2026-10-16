import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxH3SamplerPreview";
const PREVIEW_PROPERTY = "elvaxH3PreviewVideo";
const MIN_PREVIEW_HEIGHT = 180;
const PREVIEW_BOTTOM_SPACE = 16;
const installedNodes = new WeakSet();
const promptPreviewNodes = new Map();
const pendingPreviews = new Map();
let loopAllH3Previews = false;

function previewNodeId(node) {
  node.properties ??= {};
  node.properties.elvaxH3PreviewNodeId ??= crypto.randomUUID();
  return node.properties.elvaxH3PreviewNodeId;
}

function updateLoopState() {
  document.querySelectorAll(".elvax-h3-preview-video").forEach((video) => {
    video.loop = loopAllH3Previews;
  });
  document.querySelectorAll(".elvax-h3-loop-toggle").forEach((button) => {
    button.setAttribute("aria-pressed", String(loopAllH3Previews));
    button.style.backgroundColor = loopAllH3Previews ? "#36553b" : "#222c";
    button.style.borderColor = loopAllH3Previews ? "#8b9" : "#666";
  });
}

function previewUrl(entry) {
  const params = new URLSearchParams({
    filename: entry.filename,
    subfolder: entry.subfolder || "",
    type: entry.type || "temp",
  });
  return api.apiURL(`/view?${params}`);
}

function previewEntry(output) {
  const item = output?.elvax_h3_video?.find((entry) => entry?.filename);
  if (!item) return null;
  return {
    filename: item.filename,
    subfolder: item.subfolder || "",
    type: item.type || "temp",
  };
}

function findNodeByQualifiedId(rootGraph, qualifiedId) {
  if (!rootGraph || qualifiedId == null) return null;
  const parts = String(qualifiedId).split(":");
  let graph = rootGraph;
  for (let index = 0; index < parts.length - 1; index++) {
    const parent = graph?.getNodeById?.(parseInt(parts[index], 10));
    if (!parent?.subgraph) return null;
    graph = parent.subgraph;
  }
  return graph?.getNodeById?.(parseInt(parts.at(-1), 10)) || null;
}

function base64Blob(data, mime) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function makeToolbarIcon(paths) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

function installPreview(node) {
  if (installedNodes.has(node)) return;
  installedNodes.add(node);
  let disposed = false;

  const root = document.createElement("div");
  root.style.cssText = `position:relative;display:flex;align-items:center;justify-content:center;contain:size;width:100%;height:100%;min-height:${MIN_PREVIEW_HEIGHT}px;overflow:hidden;background:#111;`;
  const stage = document.createElement("div");
  stage.tabIndex = -1;
  stage.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;width:100%;height:100%;overflow:hidden;background:#111;outline:none;";
  const viewport = document.createElement("div");
  viewport.style.cssText = "position:relative;display:flex;flex:1;align-items:center;justify-content:center;width:100%;min-height:0;overflow:hidden;";
  stage.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === stage) stage.focus();
  });
  stage.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || document.fullscreenElement !== stage) return;
    event.preventDefault();
    event.stopPropagation();
    const player = currentPlayer();
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  });
  const video = document.createElement("video");
  video.className = "elvax-h3-preview-video";
  video.controls = false;
  video.playsInline = true;
  video.preload = "metadata";
  video.loop = loopAllH3Previews;
  video.style.cssText = "display:none;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;object-fit:contain;background:#111;";
  const supportsLivePreview = node.comfyClass === NODE_TYPE || node.type === NODE_TYPE;
  const liveImage = supportsLivePreview ? document.createElement("img") : null;
  const liveVideo = supportsLivePreview ? document.createElement("video") : null;
  let liveVideoUrl = null;
  if (liveImage) {
    liveImage.style.cssText = "display:none;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain;background:#111;";
    liveImage.alt = "Live sampler preview";
    liveVideo.className = "elvax-h3-preview-video";
    liveVideo.muted = true;
    liveVideo.autoplay = true;
    liveVideo.loop = true;
    liveVideo.playsInline = true;
    liveVideo.style.cssText = "display:none;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain;background:#111;";
  }
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "position:absolute;top:8px;right:8px;display:none;gap:6px;z-index:2;opacity:0;transition:opacity 120ms ease;";

  const transport = document.createElement("div");
  transport.className = "elvax-h3-transport";
  transport.style.cssText = "display:none;flex:0 0 auto;align-self:stretch;align-items:center;gap:5px;margin:6px 8px 8px;box-sizing:border-box;padding:4px 6px;border:1px solid #ffffff24;border-radius:6px;background:#111d;color:#fff;font:12px Arial,sans-serif;";
  const transportStyle = document.createElement("style");
  transportStyle.textContent = `
    .elvax-h3-transport button { display:flex; flex:0 0 24px; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:0; border-radius:4px; background:transparent; color:#fff; cursor:pointer; }
    .elvax-h3-transport button:hover { background:#ffffff24; }
    .elvax-h3-transport button svg { width:16px; height:16px; }
    .elvax-h3-transport input[type=range] { min-width:0; height:16px; margin:0; appearance:none; background:transparent; cursor:pointer; }
    .elvax-h3-transport input[type=range]::-webkit-slider-runnable-track { height:3px; border-radius:2px; background:#888; }
    .elvax-h3-transport input[type=range]::-webkit-slider-thumb { width:9px; height:9px; margin-top:-3px; appearance:none; border:0; border-radius:50%; background:#fff; }
    .elvax-h3-transport .elvax-h3-time { flex:0 0 auto; color:#eee; font:11px Arial,sans-serif; white-space:nowrap; }
    .elvax-h3-transport .elvax-h3-seek { flex:1 1 auto; }
    .elvax-h3-transport .elvax-h3-volume { flex:0 1 42px; width:42px; }
    .elvax-h3-transport.compact .elvax-h3-time { display:none; }
    .elvax-h3-transport.compact .elvax-h3-volume { flex-basis:30px; width:30px; }
  `;
  root.append(transportStyle);

  function makeTransportButton(icon, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.append(icon);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    transport.append(button);
    return button;
  }

  function makeRange(className, min, max, value, label) {
    const input = document.createElement("input");
    input.type = "range";
    input.className = className;
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.setAttribute("aria-label", label);
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("wheel", (event) => event.stopPropagation());
    transport.append(input);
    return input;
  }

  const playButton = makeTransportButton(makeToolbarIcon(["M8 5v14l11-7z"]), "Play", () => {
    const player = currentPlayer();
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  });
  const timeLabel = document.createElement("span");
  timeLabel.className = "elvax-h3-time";
  timeLabel.textContent = "0:00 / 0:00";
  transport.append(timeLabel);
  const seek = makeRange("elvax-h3-seek", 0, 1000, 0, "Seek video");
  const muteButton = makeTransportButton(makeToolbarIcon([
    "M11 5 6 9H3v6h3l5 4z",
    "M15.5 8.5a5 5 0 0 1 0 7",
    "M19 5a10 10 0 0 1 0 14",
  ]), "Mute", () => {
    const player = currentPlayer();
    if (player.muted || player.volume === 0) {
      if (player.volume === 0) player.volume = lastVolume;
      player.muted = false;
    } else {
      lastVolume = player.volume;
      player.muted = true;
    }
    updateMuteButton();
  });
  const volume = makeRange("elvax-h3-volume", 0, 1, 1, "Volume");
  volume.step = "0.01";
  volume.addEventListener("input", () => {
    const player = currentPlayer();
    player.volume = Number(volume.value);
    if (player.volume > 0) lastVolume = player.volume;
    player.muted = player.volume === 0;
    updateMuteButton();
  });
  makeTransportButton(makeToolbarIcon([
    "M8 3H5a2 2 0 0 0-2 2v3",
    "M16 3h3a2 2 0 0 1 2 2v3",
    "M21 16v3a2 2 0 0 1-2 2h-3",
    "M3 16v3a2 2 0 0 0 2 2h3",
  ]), "Fullscreen", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stage.requestFullscreen?.();
  });
  const downloadButton = makeTransportButton(makeToolbarIcon([
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "M7 10l5 5 5-5",
    "M12 15V3",
  ]), "Download video", () => {
    const player = currentPlayer();
    const href = player === liveVideo ? liveVideoUrl : activeEntry && previewUrl(activeEntry);
    if (!href) return;
    const link = document.createElement("a");
    link.href = href;
    link.download = player === liveVideo ? "h3-preview.mp4" : activeEntry.filename;
    link.click();
  });
  let lastVolume = 1;

  function currentPlayer() {
    return liveVideo?.style.display === "block" ? liveVideo : video;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function updateTransport() {
    const player = currentPlayer();
    const hasVideo = activeEntry || player === liveVideo && liveVideoUrl;
    transport.style.display = hasVideo ? "flex" : "none";
    const playTitle = player.paused ? "Play" : "Pause";
    if (playButton.title !== playTitle) {
      playButton.replaceChildren(makeToolbarIcon(player.paused ? ["M8 5v14l11-7z"] : ["M7 5h4v14H7zM15 5h4v14h-4z"]));
      playButton.title = playTitle;
      playButton.setAttribute("aria-label", playTitle);
    }
    const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    seek.max = String(Math.max(1, Math.floor(duration * 1000)));
    seek.value = String(Math.min(Number(seek.max), Math.floor(current * 1000)));
    volume.value = String(player.muted ? 0 : player.volume);
    updateMuteButton();
  }

  function updateMuteButton() {
    const player = currentPlayer();
    const muted = player.muted || player.volume === 0;
    muteButton.style.color = muted ? "#aaa" : "#8bd4ff";
    const muteTitle = muted ? "Unmute" : "Mute";
    if (muteButton.title === muteTitle) return;
    muteButton.replaceChildren(makeToolbarIcon(muted
      ? ["M11 5 6 9H3v6h3l5 4z", "m16 9 5 6m0-6-5 6"]
      : ["M11 5 6 9H3v6h3l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M19 5a10 10 0 0 1 0 14"]));
    muteButton.title = muteTitle;
    muteButton.setAttribute("aria-label", muteButton.title);
  }

  seek.addEventListener("input", () => {
    const player = currentPlayer();
    player.currentTime = Number(seek.value) / 1000;
    updateTransport();
  });
  for (const player of [video, liveVideo].filter(Boolean)) {
    for (const eventName of ["play", "pause", "timeupdate", "loadedmetadata", "volumechange", "durationchange"]) {
      player.addEventListener(eventName, updateTransport);
    }
  }
  const resizeObserver = new ResizeObserver(() => {
    transport.classList.toggle("compact", root.clientWidth < 250);
  });
  resizeObserver.observe(root);

  function makeActionButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    if (label instanceof Element) button.append(label);
    else button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.style.cssText = "display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid #666;border-radius:4px;background:#222c;color:#fff;font:600 18px/1 Arial,sans-serif;cursor:pointer;";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    toolbar.append(button);
    return button;
  }

  let activeEntry = null;
  const updateToolbar = () => {
    toolbar.style.display = activeEntry ? "flex" : "none";
    toolbar.style.opacity = root.matches(":hover") ? "1" : "0";
  };
  const loopButton = makeActionButton(makeToolbarIcon([
    "M3 12c0-4 5-6 9 0s9 4 9 0-5-6-9 0-9 4-9 0",
  ]), "Loop all H3 previews", () => {
    loopAllH3Previews = !loopAllH3Previews;
    updateLoopState();
  });
  loopButton.classList.add("elvax-h3-loop-toggle");
  updateLoopState();
  makeActionButton("↗", "Open preview in a new tab", () => {
    if (activeEntry) window.open(previewUrl(activeEntry), "_blank");
  });
  makeActionButton(makeToolbarIcon([
    "M20 11a8 8 0 0 0-14.8-4L3 10",
    "M3 5v5h5",
    "M4 13a8 8 0 0 0 14.8 4L21 14",
    "M21 19v-5h-5",
  ]), "Sync preview", () => {
    for (const preview of document.querySelectorAll(
      ".vhs_preview video, .elvax-h3-preview-video",
    )) {
      try {
        preview.currentTime = 0;
      } catch {}
      preview.play().catch(() => {});
    }
  });
  root.addEventListener("pointerenter", updateToolbar);
  root.addEventListener("pointerleave", updateToolbar);
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });

  let middleDragPointer = null;
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    middleDragPointer = event.pointerId;
    root.setPointerCapture(event.pointerId);
    app.canvas._mousedown_callback(event);
  }, true);
  root.addEventListener("pointermove", (event) => {
    if (event.pointerId !== middleDragPointer) return;
    event.preventDefault();
    app.canvas._mousemove_callback(event);
  }, true);
  const finishMiddleDrag = (event) => {
    if (event.pointerId !== middleDragPointer) return;
    event.preventDefault();
    middleDragPointer = null;
    app.canvas._mouseup_callback(event);
  };
  root.addEventListener("pointerup", finishMiddleDrag, true);
  root.addEventListener("pointercancel", finishMiddleDrag, true);
  const message = document.createElement("div");
  message.textContent = "Run the sampler to create a video preview.";
  message.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;color:#aaa;font:12px sans-serif;text-align:center;pointer-events:none;";
  viewport.append(video);
  if (liveImage) viewport.append(liveImage, liveVideo);
  viewport.append(message, toolbar);
  stage.append(viewport, transport);

  root.append(stage);

  const widget = node.addDOMWidget("h3_video_preview", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_PREVIEW_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: MIN_PREVIEW_HEIGHT, minWidth: 1 });

  function enforcePreviewMinimumHeight() {
    if (disposed) return;
    const size = node.computeSize?.();
    if (!size) return;
    const previewTop = Number.isFinite(widget.last_y) && widget.last_y > 0
      ? widget.last_y
      : Math.max(0, size[1] - MIN_PREVIEW_HEIGHT);
    const minimumHeight = Math.ceil(
      previewTop + MIN_PREVIEW_HEIGHT + PREVIEW_BOTTOM_SPACE,
    );
    node.min_size = [node.min_size?.[0] || 0, minimumHeight];
    if ((node.size?.[1] || 0) < minimumHeight) {
      node.setSize([node.size?.[0] || size[0], minimumHeight]);
    }
  }
  requestAnimationFrame(() => requestAnimationFrame(enforcePreviewMinimumHeight));

  function showEntry(entry) {
    if (disposed) return;
    if (liveImage) {
      liveImage.style.display = "none";
      liveImage.removeAttribute("src");
      liveVideo.pause();
      liveVideo.removeAttribute("src");
      liveVideo.style.display = "none";
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = null;
    }
    if (!entry?.filename) {
      activeEntry = null;
      video.pause();
      video.removeAttribute("src");
      video.style.display = "none";
      updateToolbar();
      updateTransport();
      message.textContent = "Run the sampler to create a video preview.";
      message.style.display = "block";
      node.graph?.setDirtyCanvas(true, true);
      return;
    }

    activeEntry = entry;
    updateToolbar();
    video.src = previewUrl(entry);
    video.style.display = "block";
    message.style.display = "none";
    video.load();
    updateTransport();
    node.graph?.setDirtyCanvas(true, true);
  }

  function showLivePreview(data) {
    if (disposed || !supportsLivePreview || !data?.image) return;
    const mime = data.mime || "image/jpeg";
    activeEntry = null;
    updateToolbar();
    video.pause();
    video.removeAttribute("src");
    video.style.display = "none";
    message.style.display = "none";
    if (mime === "video/mp4") {
      liveImage.style.display = "none";
      liveImage.removeAttribute("src");
      liveVideo.pause();
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = URL.createObjectURL(base64Blob(data.image, mime));
      liveVideo.src = liveVideoUrl;
      liveVideo.style.display = "block";
      liveVideo.load();
      liveVideo.play().catch(() => {});
      updateTransport();
    } else {
      liveVideo.pause();
      liveVideo.removeAttribute("src");
      liveVideo.style.display = "none";
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = null;
      liveImage.src = `data:${mime};base64,${data.image}`;
      liveImage.style.display = "block";
      updateTransport();
    }
    node.graph?.setDirtyCanvas(true, true);
  }

  function receiveOutput(output) {
    if (output?.elvax_h3_live_preview) {
      node.properties ??= {};
      delete node.properties[PREVIEW_PROPERTY];
      return;
    }
    const entry = previewEntry(output);
    node.properties ??= {};
    if (entry) node.properties[PREVIEW_PROPERTY] = entry;
    else delete node.properties[PREVIEW_PROPERTY];
    showEntry(entry);
  }
  node.__elvaxH3ShowPreview = showEntry;
  node.__elvaxH3ShowLivePreview = showLivePreview;

  video.addEventListener("error", () => {
    if (disposed) return;
    activeEntry = null;
    updateToolbar();
    video.style.display = "none";
    updateTransport();
    message.textContent = "Preview expired or unavailable. Run the sampler again.";
    message.style.display = "block";
  });

  const originalExecuted = node.onExecuted;
  node.onExecuted = function (output) {
    const result = originalExecuted?.apply(this, arguments);
    receiveOutput(output);
    return result;
  };

  function restorePreview() {
    if (disposed) return;
    const stableId = previewNodeId(node);
    if (pendingPreviews.has(stableId)) {
      const pending = pendingPreviews.get(stableId);
      if (pending) node.properties[PREVIEW_PROPERTY] = pending;
      else delete node.properties[PREVIEW_PROPERTY];
      pendingPreviews.delete(stableId);
    }
    showEntry(node.properties?.[PREVIEW_PROPERTY]);
  }

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(restorePreview);
    return result;
  };
  requestAnimationFrame(restorePreview);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    disposed = true;
    resizeObserver.disconnect();
    for (const player of [video, liveVideo].filter(Boolean)) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    liveImage?.removeAttribute("src");
    if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
    liveVideoUrl = null;
    return originalRemoved?.apply(this, args);
  };

  const originalAdded = node.onAdded;
  node.onAdded = function (...args) {
    const result = originalAdded?.apply(this, args);
    if (disposed) {
      disposed = false;
      resizeObserver.observe(root);
      restorePreview();
    }
    return result;
  };
}

app.registerExtension({
  name: "elvax.h3-sampler-preview",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      installPreview(node);
    }
  },
});

api.addEventListener("executed", ({ detail }) => {
  const promptNodes = promptPreviewNodes.get(detail?.prompt_id);
  const stableId = promptNodes?.get(String(detail?.node));
  if (!stableId) return;

  let node = app.graph.getNodeById(detail?.node);
  if (!node && typeof detail?.node === "string") {
    node = app.graph.getNodeById(parseInt(detail.node, 10));
  }
  if (node && (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE || previewNodeId(node) !== stableId)) {
    node = null;
  }
  if (detail?.output?.elvax_h3_live_preview) {
    pendingPreviews.set(stableId, null);
    if (node) {
      node.properties ??= {};
      delete node.properties[PREVIEW_PROPERTY];
    }
    return;
  }
  const entry = previewEntry(detail?.output);
  if (node) {
    node.properties ??= {};
    if (entry) node.properties[PREVIEW_PROPERTY] = entry;
    else delete node.properties[PREVIEW_PROPERTY];
    node.__elvaxH3ShowPreview?.(entry);
  } else {
    pendingPreviews.set(stableId, entry);
  }
});

const originalQueuePrompt = api.queuePrompt.bind(api);
api.queuePrompt = async function (number, promptData, options) {
  const result = await originalQueuePrompt(number, promptData, options);
  const nodeIds = new Map();
  for (const node of promptData?.workflow?.nodes ?? []) {
    if (node.type === NODE_TYPE && node.properties?.elvaxH3PreviewNodeId) {
      nodeIds.set(String(node.id), node.properties.elvaxH3PreviewNodeId);
    }
  }
  if (result?.prompt_id && nodeIds.size) {
    promptPreviewNodes.set(result.prompt_id, nodeIds);
  }
  return result;
};

for (const eventName of ["execution_success", "execution_error", "execution_interrupted"]) {
  api.addEventListener(eventName, ({ detail }) => {
    promptPreviewNodes.delete(detail?.prompt_id);
  });
}

api.addEventListener("kj_preview_override", ({ detail }) => {
  const node = findNodeByQualifiedId(app.graph, detail?.node_id);
  if (node?.comfyClass !== NODE_TYPE && node?.type !== NODE_TYPE) return;
  node.__elvaxH3ShowLivePreview?.(detail);
});
