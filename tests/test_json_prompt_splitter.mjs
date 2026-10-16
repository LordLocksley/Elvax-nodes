import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/json_prompt_splitter.js", import.meta.url), "utf8")
  .replace(/^import .*\r?\n/, "");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(count = "3", stages = 3) {
  let extension;
  let interval;
  const frames = [];
  const graph = {
    _nodes: [], _groups: [], links: {},
    getNodeById(id) { return this._nodes.find((node) => String(node.id) === String(id)); },
    setDirtyCanvas() {},
  };
  const app = {
    graph,
    registerExtension(value) { extension = value; },
    graphToPrompt() { return graph._nodes.map(({ id, mode }) => ({ id, mode })); },
  };
  const context = vm.createContext({
    app,
    window: { setInterval(callback) { interval = callback; } },
    requestAnimationFrame(callback) { frames.push(callback); },
  });
  vm.runInContext(source, context);
  extension.setup();
  const builder = { id: 1, type: "ElvaxJSONPromptBuilder", widgets: [{ name: "video_count", value: count }], updateArea() {} };
  graph._nodes.push(builder);
  for (let stage = 1; stage <= stages; stage++) {
    const target = { id: stage + 10, mode: 0, updateArea() {} };
    graph._nodes.push(target);
    graph._groups.push({ id: stage, title: `Stage ${stage}`, nodes: [target], recomputeInsideNodes() {} });
  }
  function createSplitter(properties = {}) {
    const node = {
      id: graph._nodes.length + 100, type: "ElvaxJSONPromptSplitter", mode: 0, graph,
      inputs: [{ name: "json_string" }],
      outputs: Array.from({ length: 32 }, (_, index) => ({ name: `prompt_${index + 1}`, links: [] })),
      widgets: [], properties, size: [330, 744],
      addWidget(type, name, value, callback, options) {
        const widget = { type, name, value, callback, options };
        this.widgets.push(widget);
        return widget;
      },
      addOutput(name) { this.outputs.push({ name, links: [] }); },
      removeOutput(index) { this.outputs.splice(index, 1); },
      computeSize() { return [330, this.outputs.length * 22 + this.widgets.length * 24 + 16]; },
      setSize(size) { this.size = size; },
      updateArea() {},
      configure(data) {
        while (data.outputs.length < 32) data.outputs.push({});
        this.onConfigure(data);
      },
    };
    graph._nodes.push(node);
    extension.nodeCreated(node);
    return node;
  }
  const node = createSplitter();
  while (frames.length) frames.shift()();
  const toggle = (enabled, target = node) => target.widgets.find((widget) => widget.name === "bypass_unused_stages").callback(enabled);
  const setCount = (value) => { builder.widgets[0].value = value; interval(); };
  return { graph, app, node, builder, toggle, setCount, tick: () => interval(), extension, createSplitter };
}

test("stage bypass is opt-in and follows the live count without disconnecting prompt outputs", () => {
  const f = fixture();
  assert.equal(f.node.properties.bypass_unused_stages, false);
  f.setCount("2");
  assert.equal(f.graph._groups[2].nodes[0].mode, 0);
  f.setCount("3");
  f.node.outputs[2].links = [123];
  f.toggle(true);
  f.setCount("2");
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 4]);
  assert.equal(f.node.outputs.length, 3);
  assert.deepEqual(f.node.outputs[2].links, [123]);
  f.setCount("1");
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 4, 4]);
  f.setCount("3");
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 0]);
});

test("all 32 stages are supported, including an explicit zero count", () => {
  const f = fixture("32", 32);
  f.toggle(true);
  assert.equal(f.node.properties.elvaxStageGroups.length, 32);
  assert.equal(f.node.widgets.length, 1);
  f.setCount("16");
  assert.ok(f.graph._groups.slice(0, 16).every((group) => group.nodes[0].mode === 0));
  assert.ok(f.graph._groups.slice(16).every((group) => group.nodes[0].mode === 4));
  f.setCount("0");
  assert.ok(f.graph._groups.every((group) => group.nodes[0].mode === 4));
  f.setCount("32");
  assert.ok(f.graph._groups.every((group) => group.nodes[0].mode === 0));
});

test("empty, missing, invalid, and ambiguous Builder counts leave stage modes unchanged", () => {
  const f = fixture("2");
  f.toggle(true);
  for (const value of ["", " ", "invalid", "-1", "1.5", null, undefined]) {
    f.setCount(value);
    assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 4]);
  }
  f.setCount("2");
  f.graph._nodes.push({ id: 99, type: "ElvaxJSONPromptBuilder", widgets: [{ name: "video_count", value: "1" }] });
  f.tick();
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 4]);
  f.graph._nodes = f.graph._nodes.filter((node) => node.type !== "ElvaxJSONPromptBuilder");
  f.tick();
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 4]);
});

test("turning off or deleting the Splitter restores its changes and preserves manual modes", () => {
  for (const stop of ["toggle", "remove", "bypass"]) {
    const f = fixture("1");
    f.graph._groups[1].nodes[0].mode = 2;
    f.graph._groups[2].nodes[0].mode = 4;
    f.toggle(true);
    assert.equal(f.graph._groups[1].nodes[0].mode, 4);
    if (stop === "toggle") f.toggle(false);
    else if (stop === "remove") f.node.onRemoved();
    else { f.node.mode = 4; f.tick(); }
    assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 2, 4]);
    assert.equal(f.node.properties.elvaxStageModes, undefined);
  }
});

test("assignments and prior modes survive save/load and group renaming", () => {
  const f = fixture("1");
  f.toggle(true);
  const saved = plain(f.node.properties);
  f.node.onRemoved();
  f.graph._nodes = f.graph._nodes.filter((node) => node !== f.node);
  f.graph._groups[2].title = "Renamed last stage";
  const restored = f.createSplitter(saved);
  f.tick();
  assert.equal(restored.properties.elvaxStageGroups[2], f.graph._groups[2].id);
  f.setCount("3");
  assert.deepEqual(f.graph._groups.map((group) => group.nodes[0].mode), [0, 0, 0]);
});

test("saved assignments restore released groups and follow moved nodes", () => {
  const f = fixture("1");
  f.toggle(true);
  f.graph._groups[2].title = "Custom group";
  f.node.properties.elvaxStageGroups[2] = null;
  f.tick();
  assert.equal(f.graph._groups[2].nodes[0].mode, 0);
  f.node.properties.elvaxStageGroups[2] = f.graph._groups[2].id;
  f.tick();
  assert.equal(f.graph._groups[2].nodes[0].mode, 4);
  const moved = f.graph._groups[2].nodes.pop();
  f.tick();
  assert.equal(moved.mode, 0);
});

test("the active group wins when stage groups overlap and the Splitter never bypasses itself", () => {
  const f = fixture("1");
  f.graph._groups[2].nodes.push(f.graph._groups[0].nodes[0], f.node);
  f.toggle(true);
  assert.equal(f.graph._groups[0].nodes[0].mode, 0);
  assert.equal(f.node.mode, 0);
  assert.equal(f.graph._groups[2].nodes[0].mode, 4);
});

test("queuing synchronizes a last-second count change before the graph is serialized", () => {
  const f = fixture();
  f.toggle(true);
  f.builder.widgets[0].value = "1";
  const prompt = f.app.graphToPrompt();
  assert.equal(prompt.find((node) => node.id === f.graph._groups[2].nodes[0].id).mode, 4);
});

test("graph loading waits until all groups and saved properties are configured", () => {
  const f = fixture("1");
  f.toggle(true);
  f.extension.beforeConfigureGraph();
  f.setCount("3");
  assert.equal(f.graph._groups[2].nodes[0].mode, 4);
  f.extension.afterConfigureGraph();
  assert.equal(f.graph._groups[2].nodes[0].mode, 0);
});

test("loading without a Builder preserves saved sockets and stays compact", () => {
  const f = fixture();
  f.graph._nodes = f.graph._nodes.filter((node) => node !== f.builder);
  const restored = f.createSplitter();
  restored.configure({ outputs: [{}, {}, {}] });
  f.tick();
  assert.equal(restored.outputs.length, 3);
  f.extension.loadedGraphNode(restored);
  assert.equal(restored.properties.bypass_unused_stages, false);
});

test("repeated toggles never add controls or increase the node height", () => {
  const f = fixture("2");
  const height = f.node.size[1];
  for (let index = 0; index < 25; index++) {
    f.toggle(true);
    f.tick();
    assert.deepEqual(f.node.widgets.map(widget => widget.name), ["bypass_unused_stages"]);
    assert.equal(f.graph._groups[2].nodes[0].mode, 4);
    f.toggle(false);
    f.tick();
    assert.deepEqual(f.node.widgets.map(widget => widget.name), ["bypass_unused_stages"]);
    assert.equal(f.graph._groups[2].nodes[0].mode, 0);
    assert.equal(f.node.size[1], height);
  }
});

test("newly added stage groups are detected automatically without extra controls", () => {
  const f = fixture("2");
  f.toggle(true);
  const target = { id: 44, mode: 0, updateArea() {} };
  f.graph._nodes.push(target);
  f.graph._groups.push({ id: 4, title: "Stage 4", nodes: [target], recomputeInsideNodes() {} });
  f.tick();
  assert.equal(f.node.properties.elvaxStageGroups[3], 4);
  assert.equal(target.mode, 4);
  assert.equal(f.node.widgets.length, 1);
  f.setCount("4");
  assert.equal(target.mode, 0);
});
