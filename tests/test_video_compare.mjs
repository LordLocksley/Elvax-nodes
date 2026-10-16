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
  assert.match(f.message.textContent, /Run the connected Save Video node/);
  assert.equal(button.disabled, false);
});

test("Load Video still uses its currently selected file", async () => {
  const f = fixture({ type: "LoadVideo", id: 12, widgets: [{ name: "file", value: "selected.mp4" }] });
  await f.context.capture("before", {});
  assert.deepEqual(f.requests[0].entry, { filename: "selected.mp4", type: "input" });
});
