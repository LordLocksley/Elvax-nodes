import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxVideoCompare";
const MIN_HEIGHT = 180;
const MIN_SIZE = 360;

export function comparisonDuration(videos) {
  const durations = videos.filter((video) => video.hasAttribute("src"))
    .map((video) => video.duration).filter((duration) => Number.isFinite(duration) && duration > 0);
  return durations.length ? Math.max(...durations) : 0;
}

function mediaURL(entry) {
  return api.apiURL(`/view?${new URLSearchParams({
    filename: entry.filename, subfolder: entry.subfolder || "", type: entry.type || "input",
  })}`);
}

function inputSlot(node, role) {
  return node.inputs?.findIndex((input) => input.name === `${role}_video`) ?? -1;
}

function inputNode(node, role) {
  const slot = inputSlot(node, role);
  const graph = node.graph;
  const linkId = slot >= 0 ? node.inputs[slot]?.link : null;
  const link = linkId == null ? null : graph?.links?.[linkId];
  return link ? graph.getNodeById(link.origin_id) : null;
}

function inputKey(node, role) {
  const slot = inputSlot(node, role);
  const link = slot >= 0 ? node.inputs[slot]?.link : null;
  return link == null ? null : String(link);
}

function timeLabel(time) {
  const seconds = Math.max(0, Math.floor(time || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function install(node) {
  if (node.__elvaxVideoCompare) return;
  node.__elvaxVideoCompare = true;
  node.properties ||= {};
  node.properties.elvaxVideoCompare ||= { position: 50, volume: 1, muted: false, loop: true, audioSource: null };
  const state = () => node.properties.elvaxVideoCompare;
  function migrateAudioDefault() {
    if (state().audioDefaultVersion === 1) return;
    state().muted = false;
    state().audioDefaultVersion = 1;
  }
  migrateAudioDefault();
  let disposed = false;
  let animation = 0;
  let playing = false;
  let playStarting = false;
  let playRequest = 0;
  let playbackMaster = null;
  let playbackDuration = 0;
  let renderedTime = null;
  let seekRenderTarget = null;
  let pendingFrameSteps = 0;
  let frameStepInFlight = false;
  let pendingTimelineSeek = null;
  let resumeAfterSeek = false;
  let timelineDragging = false;
  const frameQueues = new Map();
  const frameIntervals = new Map();
  const frameCallbacks = new Map();
  let middlePointer = null;
  let hoveringVideo = false;
  const captureRequests = { before: 0, after: 0 };
  const captureButtons = new Map();

  const root = document.createElement("div");
  root.className = "elvax-video-compare";
  root.style.cssText = "position:relative;display:flex;flex-direction:column;gap:var(--compare-gap,6px);width:100%;height:100%;min-height:0;min-width:0;box-sizing:border-box;contain:size;overflow:hidden;font:12px Arial,sans-serif;color:#eee;";
  const style = document.createElement("style");
  style.textContent = `
    .elvax-video-compare,.elvax-video-compare * {user-select:none;-webkit-user-select:none;}
    .elvax-video-compare .status {user-select:text;-webkit-user-select:text;}
    .elvax-video-compare button,.elvax-video-compare input {outline:none !important;-webkit-tap-highlight-color:transparent;}
    .elvax-video-compare input[type=range]:focus,.elvax-video-compare input[type=range]:focus-visible {outline:none !important;}
    .elvax-video-compare input[type=range]::-moz-focus-outer {border:0;}
    .elvax-video-compare button {box-sizing:border-box;font:12px Arial,sans-serif;color:#eee;cursor:pointer;white-space:nowrap;}
    .elvax-video-compare button:disabled {opacity:.5;cursor:wait;}
    .elvax-video-compare .capture-row {display:flex;}
    .elvax-video-compare .captions {padding:6px 8px;font-size:11px;line-height:16px;}
    .elvax-video-compare .caption-label {color:#bbb;transition:color .16s ease,text-shadow .16s ease;}
    .elvax-video-compare .caption-label.is-active {color:#00ff78;text-shadow:0 0 8px #00ff7866;}
    .elvax-video-compare .caption-label.audio-source-hover {text-decoration:underline;text-decoration-color:#8bd4ffcc;text-decoration-thickness:1px;text-underline-offset:2px;}
    .elvax-video-compare .capture {flex:1 1 0;min-width:0;min-height:28px;padding:5px 6px;line-height:16px;border:1px solid #666;border-radius:4px;background:#333;}
    .elvax-video-compare .capture:hover {background:#444;}
    .elvax-video-compare .capture:disabled {cursor:default;background:#333;}
    .elvax-video-compare .mode-row {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));flex:0 0 auto;gap:4px;padding:2px 8px;box-sizing:border-box;border-bottom:1px solid #ffffff12;}
    .elvax-video-compare .mode-cell {position:relative;min-width:0;}
    .elvax-video-compare .mode-button {display:flex;align-items:center;justify-content:center;width:100%;height:20px;padding:1px 8px;border:1px solid transparent;border-radius:6px;background:transparent;font-size:10px;line-height:16px;color:#929eaa;transition:background .15s,color .15s,border-color .15s;}
    .elvax-video-compare .mode-button.before-after-control {gap:4px;padding-left:2px;padding-right:2px;}
    .elvax-video-compare .before-after-option {font-size:inherit;color:#929eaa;transition:color .15s;}
    .elvax-video-compare .before-after-option.is-current {color:#d6ecff;}
    .elvax-video-compare .before-after-switch {position:relative;flex:0 0 2em;width:2em;height:1.2em;box-sizing:border-box;border:0;border-radius:8em;background:#293541;box-shadow:inset 0 0 0 1px #68798a;}
    .elvax-video-compare .before-after-switch::after {content:"";position:absolute;top:50%;left:.2em;width:.8em;height:.8em;border-radius:50%;background:#d6ecff;transform:translateY(-50%);transition:transform .18s cubic-bezier(.2,.8,.2,1);}
    .elvax-video-compare .before-after-switch[data-side=after]::after {transform:translate(.8em,-50%);}
    .elvax-video-compare .before-after-switch[data-side=neutral] {background:#25282d;box-shadow:inset 0 0 0 1px #454b52;}
    .elvax-video-compare .before-after-arrows {position:absolute;left:50%;top:50%;display:none;width:1.4em;height:.9em;overflow:visible;transform:translate(-50%,-50%);}
    .elvax-video-compare .before-after-arrows path {fill:none;stroke:#9aa3ad;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
    .elvax-video-compare .before-after-switch[data-side=neutral]::after {display:none;}
    .elvax-video-compare .before-after-switch[data-side=neutral] .before-after-arrows {display:block;}
    .elvax-video-compare .mode-button:hover {background:#ffffff0c;color:#eee;}
    .elvax-video-compare .mode-button[aria-pressed=true] {background:#243749;border-color:#4c6a83;color:#d6ecff;}
    .elvax-video-compare .mode-button:disabled,.elvax-video-compare .mode-button:disabled:hover,.elvax-video-compare .mode-button:disabled[aria-pressed=true] {background:#242629;border-color:#3b3e42;color:#747a80;opacity:.6;cursor:default;}
    .elvax-video-compare .mode-button:disabled .before-after-option {color:#747a80;}
    .elvax-video-compare .mode-button:disabled .before-after-switch {background:#292c30;box-shadow:inset 0 0 0 1px #454b52;}
    .elvax-video-compare .mode-button:disabled .before-after-switch::after {background:#81878e;}
    .elvax-video-compare .mode-button:disabled .before-after-arrows path {stroke:#747a80;}
    .elvax-video-compare .transport button {display:flex;flex:0 0 24px;align-items:center;justify-content:center;width:24px;height:24px;padding:3px;background:transparent;border:0;border-radius:4px;}
    .elvax-video-compare .transport button:hover {background:#ffffff24;}
    .elvax-video-compare .transport button.audio-source {background:#8bd4ff16;box-shadow:inset 0 0 0 1px #8bd4ff40;color:#8bd4ff;font-size:11px;font-weight:600;}
    .elvax-video-compare .transport button.audio-source:disabled {cursor:default;}
    .elvax-video-compare .transport {gap:4px;padding:4px 6px;}
    .elvax-video-compare .time {flex:0 0 auto;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px;}
    .elvax-video-compare .volume {flex:0 1 42px;width:42px;min-width:14px;}
    .elvax-video-compare input[type=range] {appearance:none;height:3px;margin:0;background:#888;cursor:pointer;min-width:0;}
    .elvax-video-compare input[type=range]::-webkit-slider-thumb {appearance:none;width:9px;height:9px;background:white;border-radius:50%;}
    .elvax-video-compare .blend {flex:1;width:0;min-width:36px;height:16px;background:linear-gradient(#73879a,#73879a) center / 100% 3px no-repeat;}
    .elvax-video-compare .blend:disabled {opacity:.35;cursor:default;}
    .elvax-video-compare .blend-value {display:flex;align-items:center;justify-content:center;flex:0 0 9em;width:9em;height:2em;min-width:0;box-sizing:border-box;padding:0 .6em;border:1px solid #ffffff12;border-radius:.45em;background:#ffffff06;color:#bcd3e5;font-size:8px;line-height:1;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap;}
    .elvax-video-compare .status:empty {display:none;}
    .elvax-video-compare:fullscreen {background:#111;padding:16px;box-sizing:border-box;--compare-gap:12px;}
    .elvax-video-compare:fullscreen .capture-row {display:none;}
    .elvax-video-compare:fullscreen .mode-row {padding:8px;gap:6px;}
    .elvax-video-compare:fullscreen .mode-row,.elvax-video-compare:fullscreen .captions {width:min(100%,var(--compare-controls-width,960px));align-self:center;box-sizing:border-box;}
    .elvax-video-compare:fullscreen .mode-button {height:40px;padding:4px;font-size:clamp(16px,1.25vw,22px);line-height:1;}
    .elvax-video-compare:fullscreen .captions {font-size:clamp(16px,1.4vw,24px);line-height:1.4;padding:10px 16px;}
    .elvax-video-compare:fullscreen .blend-value {font-size:clamp(10px,.8vw,13px);}
    .elvax-video-compare:fullscreen .video-panel,.elvax-video-compare:fullscreen .status {width:min(100%,var(--compare-video-width,960px));align-self:center;}
    .elvax-video-compare:fullscreen .transport {gap:4px;padding:8px 6px;}
    .elvax-video-compare:fullscreen .transport button {flex-basis:36px;width:36px;height:44px;}
    .elvax-video-compare:fullscreen .transport button svg {width:30px;height:30px;}
    .elvax-video-compare:fullscreen .transport button.audio-source {font-size:18px;}
    .elvax-video-compare:fullscreen .time {font-size:14px;}
    .elvax-video-compare:fullscreen .volume {flex-basis:84px;width:84px;}
    .elvax-video-compare:fullscreen input[type=range] {height:5px;}
    .elvax-video-compare:fullscreen input[type=range]::-webkit-slider-thumb {width:12px;height:12px;}
    .elvax-video-compare:fullscreen input[type=range]::-moz-range-thumb {width:12px;height:12px;background:white;border:0;border-radius:50%;}
    .elvax-video-compare:fullscreen .blend {background-size:100% 5px;}
    .elvax-video-compare:fullscreen .time-seek {background-size:100% 5px !important;}
  `;
  const buttons = document.createElement("div");
  buttons.className = "capture-row";
  buttons.style.cssText = "gap:6px;flex-shrink:0;";
  const modes = document.createElement("div");
  modes.className = "mode-row";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Comparison mode");
  const modeButtons = new Map();
  const modeCells = new Map();
  for (const [mode, label, title] of [
    ["split", "Slider", "Hover over the video to compare Before on the left and After on the right."],
    ["overlay", "Before/After", "Toggle between showing Before and After. Use the Overlay slider to blend them."],
    ["side-by-side", "Side by Side", "Show both complete videos beside each other."],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    if (mode === "overlay") {
      button.classList.add("before-after-control");
      button.innerHTML = '<span class="before-after-option before-after-option-before">Before</span><span class="before-after-switch" aria-hidden="true"><svg class="before-after-arrows" viewBox="0 0 20 12"><path d="M8 2 3 6l5 4M12 2l5 4-5 4"/></svg></span><span class="before-after-option before-after-option-after">After</span>';
    } else {
      button.textContent = label;
    }
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.enabledTitle = title;
    button.dataset.mode = mode;
    button.addEventListener("click", () => {
      if (mode === "overlay") {
        const alreadySelected = state().mode === "overlay";
        state().mode = "overlay";
        state().blend = alreadySelected && state().blend <= 0.5 ? 1 : 0;
      } else {
        state().mode = mode;
      }
      updateView();
      node.graph?.setDirtyCanvas(true, true);
    });
    modeButtons.set(mode, button);
    const cell = document.createElement("div");
    cell.className = "mode-cell";
    cell.append(button);
    modes.append(cell);
    modeCells.set(mode, cell);
  }
  const blend = document.createElement("input");
  blend.className = "blend";
  blend.type = "range";
  blend.min = "0";
  blend.max = "1";
  blend.step = ".01";
  blend.title = "Blend: 0% Before, 100% After";
  blend.setAttribute("aria-label", "Blend");
  const blendValue = document.createElement("output");
  blendValue.className = "blend-value";
  blendValue.title = "Overlay blend";
  blend.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || blend.disabled) return;
    event.stopPropagation();
    state().mode = "overlay";
    updateView();
  });
  blend.addEventListener("input", () => {
    state().blend = Number(blend.value);
    state().mode = "overlay";
    updateView();
  });
  blend.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (blend.disabled) return;
    state().blend = 0.5;
    state().mode = "overlay";
    updateView();
  });
  const panel = document.createElement("div");
  panel.className = "video-panel";
  panel.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;background:#111;border-radius:4px;";
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.tabIndex = 0;
  stage.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;flex:1;min-height:0;overflow:hidden;background:#111;outline:none;";
  const videos = [document.createElement("video"), document.createElement("video")];
  const videoStyle = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent;pointer-events:none;";
  for (const video of videos) {
    video.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    video.preload = "metadata";
    video.playsInline = true;
    video.muted = true;
    frameQueues.set(video, []);
    frameIntervals.set(video, 1 / 30);
  }
  const [before, after] = videos;
  const frameSurfaces = videos.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 0;
    return canvas;
  });
  const afterClip = document.createElement("div");
  afterClip.style.cssText = "position:absolute;inset:0;background:#111;pointer-events:none;";
  afterClip.append(after, frameSurfaces[1]);
  const message = document.createElement("div");
  message.className = "status";
  message.style.cssText = "flex:0 0 auto;box-sizing:border-box;padding:6px 8px;border:1px solid #ffffff24;border-radius:6px;background:#111d;text-align:center;color:#aaa;overflow-wrap:anywhere;";
  const waitingMessage = 'Connect videos to the "before_video" and "after_video" sockets, then load them.';
  function updateStatus() {
    const ready = Boolean(state().before && state().after);
    message.textContent = ready ? "" : waitingMessage;
  }
  const captions = document.createElement("div");
  captions.className = "captions";
  captions.style.cssText = "display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:8px;color:#bbb;";
  const labels = ["Before", "After"].map((text, index) => {
    const label = document.createElement("div");
    label.className = "caption-label";
    label.textContent = text;
    label.style.cssText = index ? "margin-left:auto;" : "";
    return label;
  });
  captions.append(labels[0], blend, blendValue, labels[1]);
  const divider = document.createElement("div");
  divider.setAttribute("aria-hidden", "true");
  divider.tabIndex = -1;
  divider.style.cssText = "position:absolute;top:0;bottom:0;width:20px;transform:translateX(-50%);pointer-events:none;";
  const line = document.createElement("div");
  line.style.cssText = "position:absolute;left:50%;top:0;bottom:0;width:1px;transform:translateX(-50%);background:#ffffffe0;box-shadow:0 0 2px #0006;";
  divider.append(line);

  const transport = document.createElement("div");
  transport.className = "transport";
  transport.style.cssText = "display:flex;flex:0 0 auto;align-items:center;box-sizing:border-box;border-top:1px solid #ffffff24;background:#111d;";
  function iconButton(parent, title, paths, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths.map((path) => `<path d="${path}"/>`).join("")}</svg>`;
    button.addEventListener("click", action);
    parent.append(button);
    return button;
  }
  const playButton = iconButton(transport, "Play / pause", ["M8 5l11 7-11 7z"], togglePlayback);
  const time = document.createElement("span");
  time.className = "time";
  const seek = document.createElement("input");
  seek.className = "time-seek";
  seek.type = "range";
  seek.min = "0";
  seek.max = "0";
  seek.step = ".001";
  seek.value = "0";
  seek.title = "Seek both videos";
  seek.style.cssText = "flex:1 1 0;width:0;min-width:10px;height:12px;background:linear-gradient(#888,#888) center / 100% 3px no-repeat;";
  transport.append(time, seek);
  const mute = iconButton(transport, "Mute / unmute audio", ["M11 5L6 9H3v6h3l5 4z", "M16 9l5 6M21 9l-5 6"], () => {
    state().muted = !state().muted;
    applyAudio();
  });
  const audioSource = document.createElement("button");
  audioSource.type = "button";
  audioSource.className = "audio-source";
  audioSource.addEventListener("pointerenter", updateAudioCaptionHover);
  audioSource.addEventListener("pointerleave", updateAudioCaptionHover);
  audioSource.addEventListener("click", () => {
    state().audioSource = audioVideo() === after ? "before" : "after";
    applyAudio();
    const selected = audioVideo();
    if (playing && selected.hasAttribute("src") && !selected.paused && !selected.ended) {
      playbackMaster = selected;
      selected.playbackRate = 1;
    }
  });
  transport.append(audioSource);
  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = ".01";
  volume.value = String(state().volume ?? 1);
  volume.title = "Audio volume";
  volume.className = "volume";
  transport.append(volume);
  iconButton(transport, "Fullscreen", ["M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"], () => {
    if (document.fullscreenElement === root) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  });

  function primary() { return state().before ? before : after; }
  function audioVideo() {
    if (state().audioSource === "after" && state().after) return after;
    if (state().audioSource === "before" && state().before) return before;
    if (state().before && inputKey(node, "before")) return before;
    if (state().after && inputKey(node, "after")) return after;
    return state().before ? before : after;
  }
  function playbackVideo() {
    if (playbackMaster) return playbackMaster;
    const audio = audioVideo();
    const target = seekRenderTarget ?? pendingTimelineSeek ?? renderedTime ?? state().time ?? 0;
    if (audio.hasAttribute("src") && (!Number.isFinite(audio.duration) || target < audio.duration)) return audio;
    return after.hasAttribute("src") && (!before.hasAttribute("src") || (after.duration || 0) > (before.duration || 0)) ? after : before;
  }
  function fitFullscreenWidth() {
    if (disposed || document.fullscreenElement !== root) return;
    const video = primary();
    if (!video.videoWidth || !video.videoHeight) return;
    const styles = getComputedStyle(root);
    const availableWidth = root.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    let aspect = video.videoWidth / video.videoHeight;
    const controlsWidth = Math.floor(Math.min(availableWidth, stage.clientHeight * aspect));
    if (state().mode === "side-by-side" && state().before && state().after) {
      aspect = 2 * Math.max(aspect, after.videoWidth / after.videoHeight || aspect);
    }
    const width = Math.floor(Math.min(availableWidth, stage.clientHeight * aspect));
    const value = `${width}px`;
    if (width > 0 && root.style.getPropertyValue("--compare-video-width") !== value) {
      root.style.setProperty("--compare-video-width", value);
    }
    const controlsValue = `${controlsWidth}px`;
    if (controlsWidth > 0 && root.style.getPropertyValue("--compare-controls-width") !== controlsValue) {
      root.style.setProperty("--compare-controls-width", controlsValue);
    }
  }
  root.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === root) fitFullscreenWidth();
    else root.style.removeProperty("--compare-video-width");
  });
  function applyAudio() {
    const selected = audioVideo();
    const source = selected === after ? "after" : "before";
    for (const video of videos) {
      video.muted = true;
      video.volume = Number(state().volume ?? 1);
    }
    selected.muted = state().muted ?? false;
    const muted = selected.muted || selected.volume === 0;
    mute.style.color = muted ? "#aaa" : "#8bd4ff";
    mute.title = `Mute / unmute ${source === "after" ? "After" : "Before"} audio`;
    mute.setAttribute("aria-label", mute.title);
    mute.querySelectorAll("path")[1].setAttribute("d", muted ? "M16 9l5 6M21 9l-5 6" : "M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14");
    audioSource.textContent = source === "after" ? "A" : "B";
    audioSource.disabled = !state().before || !state().after;
    audioSource.title = `Audio: ${source === "after" ? "After (A)" : "Before (B)"}${audioSource.disabled ? "" : `. Click to switch to ${source === "after" ? "Before (B)" : "After (A)"}`}.`;
    audioSource.setAttribute("aria-label", audioSource.title);
    updateAudioCaptionHover();
    volume.title = `${source === "after" ? "After" : "Before"} audio volume`;
  }
  function updateAudioCaptionHover() {
    const hovered = audioSource.matches(":hover");
    labels[0].classList.toggle("audio-source-hover", hovered && audioSource.textContent === "B");
    labels[1].classList.toggle("audio-source-hover", hovered && audioSource.textContent === "A");
  }
  function videoBounds() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const video = primary();
    if (!video.videoWidth || !video.videoHeight) return { x: 0, y: 0, width, height };
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const videoWidth = video.videoWidth * scale;
    const videoHeight = video.videoHeight * scale;
    return { x: (width - videoWidth) / 2, y: (height - videoHeight) / 2, width: videoWidth, height: videoHeight };
  }
  function position(value) {
    state().position = Math.max(0, Math.min(100, Number(value) || 0));
    const both = Boolean(state().before && state().after);
    labels[0].classList.toggle("is-active", both && ((state().mode === "split" && state().position === 100) || (state().mode === "overlay" && state().blend === 0)));
    labels[1].classList.toggle("is-active", both && ((state().mode === "split" && state().position === 0) || (state().mode === "overlay" && state().blend === 1)));
    const bounds = videoBounds();
    const x = bounds.x + bounds.width * state().position / 100;
    if (state().mode === "split" && state().before && state().after) {
      afterClip.style.clipPath = `inset(0 0 0 ${stage.clientWidth ? 100 * x / stage.clientWidth : 0}%)`;
    }
    divider.style.left = `${x}px`;
    divider.style.top = `${bounds.y}px`;
    divider.style.bottom = "auto";
    divider.style.height = `${bounds.height}px`;
    divider.style.opacity = hoveringVideo ? "1" : "0";
    divider.setAttribute("aria-valuenow", String(Math.round(state().position)));
  }
  function updateView() {
    hoveringVideo = false;
    if (!modeButtons.has(state().mode)) state().mode = "split";
    delete state().singleView;
    delete state().splitDirection;
    state().blend ??= .5;
    const mode = state().mode;
    const both = Boolean(state().before && state().after);
    const split = both && mode === "split";
    const sideBySide = both && mode === "side-by-side";
    const layoutStyle = sideBySide
      ? "position:relative;inset:auto;flex:0 1 auto;width:auto;height:100%;max-width:50%;object-fit:contain;background:transparent;pointer-events:none;"
      : videoStyle;
    for (const surface of frameSurfaces) surface.style.cssText = layoutStyle;
    before.style.display = state().before ? "block" : "none";
    frameSurfaces[0].style.display = state().before ? "block" : "none";
    frameSurfaces[1].style.display = state().after ? "block" : "none";
    afterClip.style.display = sideBySide ? "contents" : state().after ? "block" : "none";
    afterClip.style.left = "0";
    afterClip.style.width = "100%";
    afterClip.style.clipPath = "none";
    afterClip.style.opacity = both && mode === "overlay" ? String(state().blend) : "1";
    divider.style.display = split ? "block" : "none";
    divider.tabIndex = -1;
    stage.style.cursor = split ? "ew-resize" : "default";
    for (const [key, button] of modeButtons) {
      button.setAttribute("aria-pressed", String(key === mode));
      button.disabled = !both;
    }
    blend.style.display = mode === "overlay" ? "block" : "none";
    blendValue.style.display = mode === "overlay" ? "flex" : "none";
    blend.disabled = !both;
    blend.value = String(state().blend);
    blendValue.textContent = `Overlay : ${Math.round(state().blend * 100)}%`;
    const beforeAfter = modeButtons.get("overlay");
    const percentage = Math.round(state().blend * 100);
    blend.setAttribute("aria-valuetext", `${percentage}% After blend`);
    const showing = percentage === 0 ? "Before" : percentage === 100 ? "After" : `Overlay : ${percentage}%`;
    const next = percentage <= 50 ? "After" : "Before";
    const active = state().mode === "overlay";
    const beforeSelected = active && percentage === 0;
    const afterSelected = active && percentage === 100;
    beforeAfter.querySelector(".before-after-switch").dataset.side = beforeSelected ? "before" : afterSelected ? "after" : "neutral";
    beforeAfter.querySelector(".before-after-option-before").classList.toggle("is-current", beforeSelected);
    beforeAfter.querySelector(".before-after-option-after").classList.toggle("is-current", afterSelected);
    beforeAfter.title = state().mode === "overlay"
      ? `Showing ${showing}. Click to switch to ${next}; use the Overlay slider to blend.`
      : "Click to show Before, then click again to switch to After. Use the Overlay slider to blend.";
    for (const [key, button] of modeButtons) {
      const title = button.disabled
        ? "Connect sockets and load videos first"
        : key === "overlay" ? beforeAfter.title : button.dataset.enabledTitle;
      button.title = title;
      button.setAttribute("aria-label", title);
      modeCells.get(key).title = title;
    }
    labels[0].style.display = state().before ? "block" : "none";
    labels[1].style.display = state().after ? "block" : "none";
    position(state().position ?? 50);
    fitFullscreenWidth();
  }
  function updateTime() {
    const duration = playbackDuration || comparisonDuration(videos);
    const active = videos.filter((video) => video.hasAttribute("src"));
    const ended = active.length && active.every((video) => video.ended);
    const current = Math.min(pendingTimelineSeek ?? seekRenderTarget ?? (ended ? duration : renderedTime) ?? state().time ?? 0, duration);
    if (seek.max !== String(duration)) seek.max = String(duration);
    if (seek.value !== String(current)) seek.value = String(current);
    const text = `${timeLabel(current)} / ${timeLabel(duration)}`;
    if (time.textContent !== text) time.textContent = text;
  }
  function seekBoth(value, force = false) {
    const duration = playbackDuration || comparisonDuration(videos);
    const target = Math.max(0, duration ? Math.min(value, duration) : value);
    if (playing || playStarting) {
      pause();
      resumeAfterSeek = true;
    }
    const active = videos.filter((video) => video.hasAttribute("src"));
    if (!active.length) {
      seekRenderTarget = null;
      updateTime();
      return;
    }
    const cached = active.map((video) => frameQueues.get(video).findLast((entry) =>
      Math.abs(entry.time - target) < .000001 || (entry.time <= target && entry.end - target > .00001)));
    if (cached.every(Boolean)) drawFrames(active, cached);
    clearQueuedFrames();
    seekRenderTarget = target;
    for (const video of videos) {
      video.playbackRate = 1;
      const time = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      if (video.readyState > 0 && (force || Math.abs(video.currentTime - time) > .001)) {
        video.currentTime = time;
      }
    }
    state().time = target;
    for (const video of videos) captureFrame(video);
    updateTime();
  }
  function clearQueuedFrames(video) {
    const queues = video ? [frameQueues.get(video)] : frameQueues.values();
    for (const queue of queues) {
      for (const entry of queue) entry.frame.close();
      queue.length = 0;
    }
  }
  function stepFrame(direction) {
    if (playing || playStarting) pause();
    resumeAfterSeek = false;
    if (pendingTimelineSeek !== null) flushTimelineSeek();
    pendingFrameSteps += direction;
    flushFrameSteps();
  }
  function finishFrameStep() {
    if (!frameStepInFlight) return;
    frameStepInFlight = false;
    if (pendingFrameSteps) queueMicrotask(flushFrameSteps);
  }
  function flushFrameSteps() {
    if (disposed || frameStepInFlight || seekRenderTarget !== null || !pendingFrameSteps) return;
    const clock = playbackVideo();
    if (!clock.hasAttribute("src") || clock.readyState === 0) {
      pendingFrameSteps = 0;
      return;
    }
    const queue = frameQueues.get(clock);
    const steps = pendingFrameSteps;
    pendingFrameSteps = 0;
    const current = renderedTime ?? state().time ?? 0;
    const frame = queue.find((entry) => entry.time <= current && current < entry.end) ??
      queue.reduce((closest, entry) => !closest || Math.abs(entry.time - current) < Math.abs(closest.time - current) ? entry : closest, null);
    const interval = frame?.end > frame.time ? frame.end - frame.time : frameIntervals.get(clock) || 1 / 30;
    // Seek inside the frame to avoid microsecond rounding across a frame boundary.
    const target = (frame?.time ?? current) + steps * interval + interval / 4;
    const duration = comparisonDuration(videos);
    frameStepInFlight = true;
    seekBoth(Math.max(0, Math.min(target, duration || target)), true);
    if (seekRenderTarget === null) finishFrameStep();
  }
  function renderFramePair() {
    if (disposed) return;
    const active = videos.filter((video) => video.hasAttribute("src"));
    if (!active.length) return;
    if (active.some((video) => video.seeking || video.error)) return;
    const clock = playbackVideo();
    const queue = frameQueues.get(clock);
    for (let index = queue.length - 1; index >= 0; index--) {
      const candidate = queue[index];
      const target = seekRenderTarget ?? candidate.time;
      if (seekRenderTarget !== null) {
        if (!(candidate.time <= target + .000001 && target < candidate.end) &&
          !(target >= clock.duration && candidate === queue.at(-1))) continue;
      } else if (renderedTime !== null && candidate.time <= renderedTime + .000001) continue;
      const pair = active.map((video) => {
        if (video === clock) return candidate;
        const frames = frameQueues.get(video);
        return frames.findLast((entry) => Math.abs(entry.time - candidate.time) < .000001) ??
          frames.findLast((entry) =>
          (entry.time <= target && entry.end - target > .00001) ||
          (target >= video.duration && entry === frames.at(-1)));
      });
      if (pair.some((entry) => !entry)) continue;
      drawFrames(active, pair);
      active.forEach((video, videoIndex) => {
        const entry = pair[videoIndex];
        const frames = frameQueues.get(video);
        while (frames.length > 1 && frames[1].time < entry.time) frames.shift().frame.close();
      });
      renderedTime = candidate.time;
      if (!playing) state().time = renderedTime;
      const completedSeek = seekRenderTarget !== null;
      seekRenderTarget = null;
      updateTime();
      if (completedSeek) {
        finishFrameStep();
        flushTimelineSeek();
        flushFrameSteps();
        if (resumeAfterSeek && !timelineDragging && seekRenderTarget === null && pendingTimelineSeek === null) play();
      }
      return;
    }
  }
  function drawFrames(active, pair) {
    active.forEach((video, index) => {
      const canvas = frameSurfaces[videos.indexOf(video)];
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(pair[index].frame, 0, 0, canvas.width, canvas.height);
    });
  }
  function pause(alignFrames = false) {
    const pauseTime = alignFrames && playbackMaster
      ? renderedTime ?? playbackMaster.currentTime : null;
    playRequest++;
    playStarting = false;
    playing = false;
    resumeAfterSeek = false;
    cancelAnimationFrame(animation);
    animation = 0;
    videos.forEach((video) => { video.pause(); video.playbackRate = 1; });
    if (Number.isFinite(pauseTime)) seekBoth(pauseTime + .000001, true);
    playbackMaster = null;
    playbackDuration = 0;
    playButton.querySelector("path").setAttribute("d", "M8 5l11 7-11 7z");
  }
  function tick() {
    if (!playing || disposed) return;
    const master = playbackVideo();
    if (master.seeking) {
      updateTime();
      animation = requestAnimationFrame(tick);
      return;
    }
    for (const video of videos) {
      if (video !== master && !video.ended && video.readyState >= 2 && !video.seeking && !master.seeking) {
        const drift = video.currentTime - master.currentTime;
        if (Math.abs(drift) > .12) {
          video.playbackRate = 1;
          clearQueuedFrames(video);
          video.currentTime = Number.isFinite(video.duration)
            ? Math.min(master.currentTime, video.duration)
            : master.currentTime;
        } else {
          const rate = drift > .01 ? .95 : drift < -.01 ? 1.05 : 1;
          if (video.playbackRate !== rate) video.playbackRate = rate;
        }
      }
    }
    updateTime();
    animation = requestAnimationFrame(tick);
  }
  function waitForMetadata(video) {
    if (video.readyState >= 1 || video.error) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("error", done);
        video.removeEventListener("abort", done);
        video.removeEventListener("emptied", done);
        resolve();
      };
      video.addEventListener("loadedmetadata", done);
      video.addEventListener("error", done);
      video.addEventListener("abort", done);
      video.addEventListener("emptied", done);
    });
  }
  function togglePlayback() {
    if (resumeAfterSeek) pause();
    else if (playing || playStarting) pause(true);
    else play();
  }
  async function play() {
    if (playing || playStarting || disposed) return;
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    if (seekRenderTarget !== null || pendingTimelineSeek !== null) {
      resumeAfterSeek = true;
      return;
    }
    resumeAfterSeek = false;
    const active = videos.filter((video) => video.hasAttribute("src"));
    if (!active.length) return;
    playStarting = true;
    const request = ++playRequest;
    await Promise.all(active.map(waitForMetadata));
    if (request !== playRequest || disposed) return;
    playStarting = false;
    const ready = active.filter((video) => video.hasAttribute("src") && !video.error && video.readyState >= 1);
    if (!ready.length) return;
    const selectedAudio = audioVideo();
    playbackMaster = ready.includes(selectedAudio) && !selectedAudio.ended
      ? selectedAudio
      : ready.reduce((longest, video) => (video.duration || 0) > (longest.duration || 0) ? video : longest);
    playbackDuration = comparisonDuration(ready);
    if (playbackDuration && playbackMaster.currentTime >= playbackDuration - .025) {
      resumeAfterSeek = true;
      seekBoth(0);
      return;
    }
    const toPlay = ready.filter((video) => !video.ended);
    applyAudio();
    playing = true;
    updateStatus();
    playButton.querySelector("path").setAttribute("d", "M8 5v14M16 5v14");
    cancelAnimationFrame(animation);
    tick();
    const results = await Promise.allSettled(toPlay.map((video) => video.play()));
    if (request !== playRequest || disposed) return;
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [{ video: toPlay[index], error: result.reason }] : []);
    if (failed.length) {
      pause();
      const failure = failed[0];
      if (failure.error?.name !== "AbortError") {
        message.textContent = `Could not play the ${failure.video === before ? "Before" : "After"} video: ${failure.error?.message || "video unavailable"}`;
      }
    }
  }
  function finishPlayback() {
    if (!playing) return;
    const duration = playbackDuration || comparisonDuration(videos);
    pause();
    if (state().loop) { seekBoth(0); play(); }
    else {
      seekBoth(Math.max(0, duration - .000001), true);
      state().time = duration;
      updateTime();
    }
  }
  function show() {
    pause();
    pendingTimelineSeek = null;
    timelineDragging = false;
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    seekRenderTarget = null;
    clearQueuedFrames();
    renderedTime = null;
    for (let index = 0; index < videos.length; index++) {
      const role = index ? "after" : "before";
      const entry = state()[role];
      const video = videos[index];
      if (entry?.filename) {
        const url = mediaURL(entry);
        if (video.getAttribute("src") !== url) {
          frameSurfaces[index].width = frameSurfaces[index].height = 0;
          video.src = url;
          video.load();
        }
      }
      else {
        frameSurfaces[index].width = frameSurfaces[index].height = 0;
        video.removeAttribute("src");
        video.load();
      }
    }
    captions.style.display = state().before || state().after ? "flex" : "none";
    updateStatus();
    updateView();
    applyAudio();
    volume.value = String(state().volume ?? 1);
    seekBoth(state().time || 0);
    updateTime();
  }
  function captureFrame(video) {
    if (disposed || video.seeking || video.readyState < 2 || !video.hasAttribute("src")) return;
    const frame = new VideoFrame(video);
    const time = frame.timestamp / 1000000;
    if (frame.duration > 0) frameIntervals.set(video, frame.duration / 1000000);
    const queue = frameQueues.get(video);
    const duplicate = queue.findIndex((entry) => Math.abs(entry.time - time) < .000001);
    if (duplicate >= 0) {
      frame.close();
      renderFramePair();
      return;
    }
    const previous = queue.at(-1);
    if (!(frame.duration > 0) && playing && previous && time > previous.time && time - previous.time < .1) {
      frameIntervals.set(video, time - previous.time);
    }
    queue.push({ frame, time, end: time + (frame.duration > 0 ? frame.duration / 1000000 : frameIntervals.get(video)) });
    while (queue.length > 6) queue.shift().frame.close();
    renderFramePair();
  }
  for (const video of videos) {
    const recordFrame = () => {
      if (disposed) return;
      frameCallbacks.set(video, video.requestVideoFrameCallback(recordFrame));
      captureFrame(video);
    };
    frameCallbacks.set(video, video.requestVideoFrameCallback(recordFrame));
    video.addEventListener("loadeddata", () => captureFrame(video));
    video.addEventListener("seeked", () => {
      captureFrame(video);
      flushTimelineSeek();
    });
    video.addEventListener("emptied", () => {
      clearQueuedFrames(video);
      frameIntervals.set(video, 1 / 30);
    });
    video.addEventListener("loadedmetadata", () => {
      if (disposed) return;
      const target = playing && playbackMaster ? playbackMaster.currentTime : state().time || 0;
      const time = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      if (Math.abs(video.currentTime - time) > .001) video.currentTime = time;
      updateTime();
      fitFullscreenWidth();
      position(state().position ?? 50);
    });
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("ended", () => {
      if (video !== playbackMaster) return;
      const nextMaster = videos.find((candidate) => candidate !== video && candidate.hasAttribute("src") && !candidate.ended && !candidate.error);
      if (nextMaster && video.duration < playbackDuration - .001) {
        playbackMaster = nextMaster;
        nextMaster.playbackRate = 1;
      } else {
        finishPlayback();
      }
    });
    video.addEventListener("error", () => {
      if (!disposed && video.hasAttribute("src")) {
        pause();
        pendingTimelineSeek = null;
        pendingFrameSteps = 0;
        frameStepInFlight = false;
        seekRenderTarget = null;
        message.textContent = `Could not load the ${video === before ? "Before" : "After"} video: ${video.error?.message || "video unavailable"}`;
      }
    });
  }
  function flushTimelineSeek(final = false) {
    if (disposed || pendingTimelineSeek === null) return;
    if (!final && (seekRenderTarget !== null || videos.some((video) => video.seeking))) return;
    const target = pendingTimelineSeek;
    pendingTimelineSeek = null;
    seekBoth(target);
  }
  function finishTimelineSeek() {
    timelineDragging = false;
    flushTimelineSeek(true);
    if (resumeAfterSeek && seekRenderTarget === null && pendingTimelineSeek === null) play();
  }
  seek.addEventListener("pointerdown", (event) => {
    if (event.button === 0) timelineDragging = true;
  });
  seek.addEventListener("input", () => {
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    pendingTimelineSeek = Number(seek.value);
    updateTime();
    flushTimelineSeek();
  });
  seek.addEventListener("change", finishTimelineSeek);
  seek.addEventListener("pointercancel", finishTimelineSeek);
  volume.addEventListener("input", () => { state().volume = Number(volume.value); state().muted = false; applyAudio(); });
  function hoverDivider(event) {
    if (event.buttons || state().mode !== "split" || !state().before || !state().after) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const video = videoBounds();
    const x = (event.clientX - bounds.left) * stage.clientWidth / bounds.width;
    const y = (event.clientY - bounds.top) * stage.clientHeight / bounds.height;
    if (x < video.x || x > video.x + video.width) {
      position(state().position >= 50 ? 100 : 0);
      hideDivider();
      return;
    }
    if (y < video.y || y > video.y + video.height) {
      position(state().position >= 50 ? 100 : 0);
      hideDivider();
      return;
    }
    hoveringVideo = true;
    if (video.width) position(100 * (x - video.x) / video.width);
  }
  stage.addEventListener("pointerenter", hoverDivider);
  stage.addEventListener("pointermove", hoverDivider);
  function hideDivider() {
    hoveringVideo = false;
    position(state().position ?? 50);
  }
  stage.addEventListener("pointerleave", (event) => {
    const bounds = stage.getBoundingClientRect();
    const video = videoBounds();
    const x = (event.clientX - bounds.left) * stage.clientWidth / bounds.width;
    const y = (event.clientY - bounds.top) * stage.clientHeight / bounds.height;
    if (y < video.y || y > video.y + video.height || x < video.x || x > video.x + video.width) {
      position(state().position >= 50 ? 100 : 0);
    }
    hideDivider();
  });
  stage.addEventListener("pointercancel", hideDivider);
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    stage.focus({ preventScroll: true });
  });
  stage.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    togglePlayback();
  });
  async function capture(role, button) {
    const source = inputNode(node, role);
    const key = inputKey(node, role);
    if (!source) return;
    const request = ++captureRequests[role];
    button.__elvaxLoading = true;
    button.disabled = true;
    try {
      let entry = state()[`${role}LatestKey`] === key ? state()[`${role}Latest`] : null;
      if (source.type === "LoadVideo") {
        const filename = source.widgets?.find((widget) => widget.name === "file")?.value;
        if (filename) entry = { filename, type: "input" };
        else throw new Error("No video is available from the connected node yet.");
      }
      if (source.type === "SaveVideo" || source.comfyClass === "SaveVideo") {
        entry = app.nodeOutputs?.[source.id]?.images?.find((video) => video.type === "output" && video.filename);
        if (!entry) throw new Error("No video is available from the connected node yet.");
      }
      if (!entry) throw new Error(`No video is available from the ${role === "before" ? "Before" : "After"} socket.`);
      const response = await api.fetchApi("/elvax/video-compare/capture", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not prepare the selected video.");
      if (disposed || request !== captureRequests[role] || key !== inputKey(node, role)) return;
      state()[role] = result;
      state().time = 0;
      show();
      node.graph?.setDirtyCanvas(true, true);
    } catch (error) { if (!disposed) message.textContent = error.message; }
    finally {
      if (!disposed && request === captureRequests[role]) {
        button.__elvaxLoading = false;
        button.disabled = !inputKey(node, role);
      }
    }
  }
  for (const role of ["before", "after"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "capture";
    button.textContent = `Load : ${role === "before" ? "Before" : "After"} Video`;
    button.title = `Load a video from the ${role}_video socket.`;
    button.addEventListener("click", () => capture(role, button));
    captureButtons.set(role, button);
    buttons.append(button);
  }
  function updateLoadButtons() {
    for (const [role, button] of captureButtons) {
      const input = node.inputs?.[inputSlot(node, role)];
      button.title = input?.link == null
        ? `Connect a video output to the ${role}_video socket.`
        : `Load a video from the ${role}_video socket.`;
      button.disabled = Boolean(button.__elvaxLoading) || input?.link == null;
    }
  }
  const oldConnectionsChanged = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const slot = arguments[1];
    const connected = arguments[2];
    const result = oldConnectionsChanged?.apply(this, arguments);
    if (connected && state().audioSource == null) {
      state().audioSource = this.inputs?.[slot]?.name === "after_video" ? "after" : "before";
    }
    updateLoadButtons();
    updateView();
    updateStatus();
    applyAudio();
    return result;
  };
  updateLoadButtons();
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    middlePointer = event.pointerId;
    root.setPointerCapture(middlePointer);
    app.canvas._mousedown_callback(event);
  }, true);
  root.addEventListener("pointermove", (event) => {
    if (event.pointerId === middlePointer) { event.preventDefault(); app.canvas._mousemove_callback(event); }
  }, true);
  const finishMiddle = (event) => {
    if (event.pointerId !== middlePointer) return;
    middlePointer = null;
    app.canvas._mouseup_callback(event);
  };
  root.addEventListener("pointerup", finishMiddle, true);
  root.addEventListener("pointercancel", finishMiddle, true);
  root.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      (event.target === seek ||
        (!["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(event.target.tagName) && !event.target.isContentEditable))) {
      event.preventDefault(); event.stopPropagation();
      stepFrame(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.code === "Space" && event.target.tagName !== "INPUT" && event.target.tagName !== "BUTTON") {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      togglePlayback();
    }
  });
  stage.append(before, frameSurfaces[0], afterClip, divider);
  panel.append(modes, captions, stage, transport);
  root.append(style, buttons, panel, message);
  const widget = node.addDOMWidget("video_compare", "div", root, {
    serialize: false, hideOnZoom: false, getMinHeight: () => MIN_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: MIN_HEIGHT, minWidth: 1 });
  const oldComputeSize = node.computeSize;
  node.computeSize = function () {
    const size = oldComputeSize.apply(this, arguments);
    size[0] = Math.max(MIN_SIZE, size[0]);
    size[1] = Math.max(MIN_SIZE, size[1]);
    return size;
  };
  const oldResize = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.max(MIN_SIZE, size[0]);
    size[1] = Math.max(MIN_SIZE, size[1]);
    return oldResize?.apply(this, arguments);
  };
  function enforceMinimumSize() {
    if (disposed || document.fullscreenElement === root) return;
    if (node.size[0] < MIN_SIZE || node.size[1] < MIN_SIZE) {
      node.setSize([Math.max(MIN_SIZE, node.size[0]), Math.max(MIN_SIZE, node.size[1])]);
    }
  }
  const sizeObserver = new ResizeObserver(() => {
    enforceMinimumSize();
    fitFullscreenWidth();
    position(state().position ?? 50);
  });
  sizeObserver.observe(root);
  sizeObserver.observe(stage);
  node.setSize([560, 560]);
  const oldSerialized = node.onSerialize;
  node.onSerialize = function (data) {
    const result = oldSerialized?.apply(this, arguments);
    data.properties = {
      ...data.properties,
      elvaxVideoCompare: JSON.parse(JSON.stringify({
        ...state(),
        time: renderedTime ?? state().time ?? 0,
      })),
    };
    return result;
  };
  const oldConfigured = node.onConfigure;
  node.onConfigure = function () {
    const result = oldConfigured?.apply(this, arguments);
    this.properties.elvaxVideoCompare ||= { position: 50, volume: 1, muted: false, loop: true, audioSource: null };
    this.properties.elvaxVideoCompare = JSON.parse(JSON.stringify(this.properties.elvaxVideoCompare));
    migrateAudioDefault();
    updateLoadButtons();
    enforceMinimumSize();
    show();
    return result;
  };
  const oldExecuted = node.onExecuted;
  node.onExecuted = function (data) {
    const result = oldExecuted?.apply(this, arguments);
    for (const role of ["before", "after"]) {
      const entry = data?.[`elvax_compare_${role}_video`]?.[0];
      if (entry) {
        state()[`${role}Latest`] = entry;
        state()[`${role}LatestKey`] = inputKey(this, role);
      }
    }
    updateStatus();
    return result;
  };
  const oldRemoved = node.onRemoved;
  node.onRemoved = function () {
    disposed = true;
    sizeObserver.disconnect();
    pause();
    clearQueuedFrames();
    for (const canvas of frameSurfaces) canvas.width = canvas.height = 0;
    for (const video of videos) {
      video.cancelVideoFrameCallback(frameCallbacks.get(video));
      video.removeAttribute("src");
      video.load();
    }
    return oldRemoved?.apply(this, arguments);
  };
  show();
}

app.registerExtension({
  name: "Elvax.VideoCompare",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const oldCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = oldCreated?.apply(this, arguments);
      install(this);
      return result;
    };
  },
});
