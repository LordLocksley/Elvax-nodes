import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/video_compare.js", import.meta.url), "utf8");
const capture = source.slice(source.indexOf("  async function capture(role, button) {"),
  source.indexOf('  for (const role of ["before", "after"])'));

function fixture(input, output, latest = {}) {
  const state = { ...latest };
  const requests = [];
  const message = { textContent: "" };
  const node = { graph: { setDirtyCanvas() {} } };
  const context = vm.createContext({
    app: { nodeOutputs: { [input.id]: output } },
    api: { async fetchApi(path, options) {
      requests.push({ path, entry: JSON.parse(options.body) });
      return { ok: true, async json() { return { filename: "captured.mp4", type: "input" }; } };
    } },
    node, inputNode: (_node, role) => input[role] || input, inputKey: (_node, role) => `${role}:saved:0`, state: () => state,
    captureRequests: { before: 0, after: 0 }, disposed: false, message, show() {},
  });
  vm.runInContext(capture, context);
  return { context, state, requests, message };
}

test("Save Video uses its saved compressed file without executing Compare", async () => {
  for (const extension of ["mp4", "mkv", "webm"]) {
    const saved = { filename: `saved.${extension}`, subfolder: "videos", type: "output" };
    const f = fixture({ type: "SaveVideo", id: 42 }, { images: [saved] });
    const button = {};
    await f.context.capture("before", button);
    assert.deepEqual(f.requests[0].entry, saved);
    assert.equal(f.state.before.filename, "captured.mp4");
    assert.equal(button.disabled, false);
  }
});

test("Save Video result takes priority over Compare's cached working file", async () => {
  const saved = { filename: "compressed.mp4", type: "output" };
  const f = fixture({ type: "SaveVideo", id: 42 }, { images: [saved] },
    { afterLatestKey: "after:saved:0", afterLatest: { filename: "working.mp4", type: "temp" } });
  await f.context.capture("after", {});
  assert.deepEqual(f.requests[0].entry, saved);
});

test("missing Save Video result does not silently load the working file", async () => {
  const f = fixture({ type: "SaveVideo", id: 42 }, undefined,
    { beforeLatestKey: "before:saved:0", beforeLatest: { filename: "working.mp4", type: "temp" } });
  const button = {};
  await f.context.capture("before", button);
  assert.equal(f.requests.length, 0);
  assert.equal(f.message.textContent, "No video is available from the connected node yet.");
  assert.equal(button.disabled, false);
});

test("Load Video still uses its currently selected file", async () => {
  const f = fixture({ type: "LoadVideo", id: 12, widgets: [{ name: "file", value: "selected.mp4" }] });
  await f.context.capture("before", {});
  assert.deepEqual(f.requests[0].entry, { filename: "selected.mp4", type: "input" });
});

function playbackFixture() {
  const saved = {};
  const drawn = [];
  const videos = [0, 1].map(() => ({
    hasAttribute: () => true, currentTime: 0, duration: 8, readyState: 2,
    videoWidth: 320, videoHeight: 180, seeking: false, ended: false, pause() {},
  }));
  const context = vm.createContext({
    videos, frameQueues: new Map(videos.map(video => [video, []])),
    frameIntervals: new Map(videos.map(video => [video, 1 / 24])),
    frameSurfaces: videos.map(() => ({getContext: () => ({drawImage: frame => drawn.push(frame.id)})})),
    playbackVideo: () => videos[0], comparisonDuration: () => 8,
    state: () => saved, disposed: false, playing: false, playStarting: false,
    renderedTime: null, seekRenderTarget: null, pendingFrameSteps: 0,
    frameStepInFlight: false, pendingTimelineSeek: null, resumeAfterSeek: false,
    timelineDragging: false,
    playbackDuration: 0, playbackMaster: null, playRequest: 0, animation: 0,
    seek: {}, time: {}, timeLabel: value => String(Math.floor(value)),
    captureFrame() {}, flushTimelineSeek() {}, play() {},
    queueMicrotask() {}, cancelAnimationFrame() {},
    playButton: {querySelector: () => ({setAttribute() {}})},
  });
  vm.runInContext(source.slice(source.indexOf("  function updateTime() {"), source.indexOf("  function waitForMetadata(video) {")), context);
  return {context, saved, videos, drawn};
}

function frame(time, interval = 1 / 24) {
  return {time, end: time + interval, frame: {id: time, close() {}}};
}

test("playback waits for the matching frame rather than displaying a nearby frame", () => {
  const f = playbackFixture();
  f.context.renderedTime = 0;
  f.context.frameQueues.get(f.videos[0]).push(frame(1 / 24));
  f.context.frameQueues.get(f.videos[1]).push(frame(0));
  f.context.renderFramePair();
  assert.deepEqual(f.drawn, []);
  f.context.frameQueues.get(f.videos[1]).push(frame(1 / 24));
  f.context.renderFramePair();
  assert.deepEqual(f.drawn, [1 / 24, 1 / 24]);
});

test("rounded frame durations do not make the preceding frame match a new frame", () => {
  const f = playbackFixture();
  f.context.renderedTime = 1.041667;
  f.context.frameQueues.get(f.videos[0]).push(frame(1.083333, .041667));
  f.context.frameQueues.get(f.videos[1]).push(frame(1.041667, .041667));
  f.context.renderFramePair();
  assert.deepEqual(f.drawn, []);
});

test("a seek near the end of a frame completes with the same frame on both sides", () => {
  const f = playbackFixture();
  f.context.seekRenderTarget = 1.249997;
  for (const video of f.videos) f.context.frameQueues.get(video).push(frame(1.208333, .041667));
  f.context.renderFramePair();
  assert.deepEqual(f.drawn, [1.208333, 1.208333]);
  assert.equal(f.context.seekRenderTarget, null);
});

test("reverse frame steps do not fall into the preceding frame because of timestamp rounding", () => {
  const f = playbackFixture();
  f.context.renderedTime = 1.666667;
  f.context.pendingFrameSteps = -10;
  f.context.frameQueues.get(f.videos[0]).push(frame(1.666667, .041667));
  f.context.flushFrameSteps();
  assert.ok(f.context.seekRenderTarget > 1.25);
  assert.ok(f.context.seekRenderTarget < 1.25 + 1 / 24);
  assert.equal(f.videos[0].currentTime, f.videos[1].currentTime);
});

test("a completed older seek cannot move the timeline away from the latest requested position", () => {
  const f = playbackFixture();
  f.context.pendingTimelineSeek = 6;
  f.context.seekRenderTarget = 2;
  f.context.renderedTime = 1;
  f.context.updateTime();
  assert.equal(f.context.seek.value, "6");
});

test("timeline seeks keep only the latest request while the previous pair is decoding", () => {
  const f = playbackFixture();
  vm.runInContext(source.slice(source.indexOf("  function flushTimelineSeek("), source.indexOf("  function finishTimelineSeek()")), f.context);
  f.context.seekRenderTarget = 2;
  f.context.pendingTimelineSeek = 4;
  f.context.flushTimelineSeek();
  f.context.pendingTimelineSeek = 6;
  f.context.flushTimelineSeek();
  assert.equal(f.videos[0].currentTime, 0);
  f.context.seekRenderTarget = null;
  f.context.flushTimelineSeek();
  assert.equal(f.videos[0].currentTime, 6);
  assert.equal(f.videos[1].currentTime, 6);
  assert.equal(f.context.pendingTimelineSeek, null);
});

test("releasing the timeline sends its final target immediately even if an older seek is pending", () => {
  const f = playbackFixture();
  vm.runInContext(source.slice(source.indexOf("  function flushTimelineSeek("), source.indexOf("  function finishTimelineSeek()")), f.context);
  f.context.seekRenderTarget = 2;
  f.context.pendingTimelineSeek = 6;
  f.context.flushTimelineSeek(true);
  assert.equal(f.videos[0].currentTime, 6);
  assert.equal(f.videos[1].currentTime, 6);
  assert.equal(f.context.seekRenderTarget, 6);
});

test("audio uses the loaded video when the preferred connected socket has no loaded clip", () => {
  const f = playbackFixture();
  f.saved.audioSource = "before";
  f.saved.after = {filename: "after.mp4"};
  f.context.before = f.videos[0];
  f.context.after = f.videos[1];
  f.context.node = {};
  f.context.inputKey = () => "connected";
  vm.runInContext(source.slice(source.indexOf("  function audioVideo() {"), source.indexOf("  function playbackVideo() {")), f.context);
  assert.equal(f.context.audioVideo(), f.videos[1]);
  f.saved.before = {filename: "before.mp4"};
  assert.equal(f.context.audioVideo(), f.videos[0]);
});

test("seeking past the shorter audio clip uses the longer video as the frame clock", () => {
  const f = playbackFixture();
  f.context.before = f.videos[0];
  f.context.after = f.videos[1];
  f.context.audioVideo = () => f.videos[0];
  f.videos[0].duration = 4;
  f.context.seekRenderTarget = 6;
  vm.runInContext(source.slice(source.indexOf("  function playbackVideo() {"), source.indexOf("  function fitFullscreenWidth() {")), f.context);
  assert.equal(f.context.playbackVideo(), f.videos[1]);
});

test("a failed secondary video start pauses the pair instead of leaving audio playing over frozen frames", async () => {
  const f = playbackFixture();
  f.context.before = f.videos[0];
  f.context.message = {textContent: ""};
  f.context.audioVideo = () => f.videos[0];
  f.context.waitForMetadata = () => Promise.resolve();
  f.context.applyAudio = f.context.updateStatus = f.context.tick = () => {};
  f.videos[0].play = () => Promise.resolve();
  f.videos[1].play = () => Promise.reject(new Error("Decoder unavailable"));
  let paused = false;
  f.context.pause = () => {paused = true; f.context.playing = false;};
  vm.runInContext(source.slice(source.indexOf("  async function play() {"), source.indexOf("  function finishPlayback() {")), f.context);
  await f.context.play();
  assert.equal(paused, true);
  assert.equal(f.context.playing, false);
  assert.match(f.context.message.textContent, /After video: Decoder unavailable/);
});
