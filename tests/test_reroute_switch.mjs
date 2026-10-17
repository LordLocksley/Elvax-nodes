import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/reroute_switch.js", import.meta.url), "utf8");
const routing = source.slice(source.indexOf("export const REROUTE_SWITCH"), source.indexOf("function install(")).replaceAll("export ", "");

test("compact switch hides labels and restores its small layout without changing routing keys", async () => {
  const app = { registerExtension(extension) { this.extension = extension; } };
  const badgeStyles = [];
  const document = { head: { append(style) { badgeStyles.push(style); } }, querySelector() { return null; }, createElement() {
    return { style: {}, children: [], attributes: {}, listeners: {}, textContent: "",
      append(child) { this.children.push(child); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, callback) { this.listeners[key] = callback; },
    };
  } };
  const context = vm.createContext({ app, document, api: { dispatchEvent() {} }, CustomEvent: class {}, LiteGraph: { NO_TITLE: 1, ROUND_RADIUS: 8 },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replaceAll("export ", ""), context);
  class Node {
    widgets = [{ name: "active_output", value: "A" }];
    inputs = [{ name: "value" }, { name: "active_output", widget: { name: "active_output" } }];
    outputs = [{ name: "A" }, { name: "B" }];
    removeInput(index) { this.inputs.splice(index, 1); }
    drawBadges() { throw new Error("Default badge drawing should not run for the switch"); }
    addDOMWidget(name, type, element, options) {
      const widget = { name, element, get value() { return options.getValue(); }, set value(value) { options.setValue(value); } };
      this.widgets.push(widget);
      return widget;
    }
  }
  await app.extension.beforeRegisterNodeDef(Node, { name: "ElvaxRerouteSwitch" });
  const node = new Node();
  node.id = 99;
  node.onNodeCreated();
  assert.equal(Node.title_mode, 1);
  assert.equal(node.hideSlotLabels, true);
  assert.equal(node.resizable, false);
  assert.deepEqual(Array.from(node.size), [42, 52]);
  assert.doesNotThrow(() => node.drawBadges());
  assert.equal(Object.hasOwn(Node.prototype, "drawBadges"), true);
  assert.throws(() => new Node().drawBadges(), /Default badge drawing/);
  assert.equal(node.inputs[0].name, "value");
  assert.equal(node.inputs.length, 1);
  for (const slot of [...node.inputs, ...node.outputs]) {
    const renderingLabel = slot.label || slot.localized_name || slot.name || "";
    assert.equal(renderingLabel.trim(), "");
  }
  assert.deepEqual(node.outputs.map((output) => output.name), ["A", "B"]);
  const control = node.widgets[0].element.children[0];
  assert.equal(control.children.length, 1);
  assert.match(control.style.cssText, /border-radius:8px/);
  assert.match(control.children[0].style.cssText, /border-radius:4px/);
  assert.equal(control.children[0].style.transform, "translateY(0)");
  assert.equal(node.outputs[1].color_on, "#4c4e52");
  assert.equal(badgeStyles.length, 1);
  assert.match(badgeStyles[0].textContent, /\.lg-node:has\(\[node-type="ElvaxRerouteSwitch"\]\)/);
  assert.match(badgeStyles[0].textContent, /\.lg-node:has\(\[node-type="ElvaxCircuitSwitch"\]\)/);
  assert.doesNotMatch(badgeStyles[0].textContent, /data-node-id=/);
  control.listeners.click({ stopPropagation() {} });
  assert.equal(node.widgets[0].value, "B");
  assert.equal(control.attributes["aria-checked"], "true");
  assert.equal(control.children[0].style.transform, "translateY(18px)");
  assert.equal(node.outputs[0].color_on, "#4c4e52");
  assert.equal(node.outputs[1].color_on, undefined);
  node.size = [300, 200];
  node.inputs[0].label = "value";
  node.outputs[0].label = "A";
  node.inputs.push({ name: "active_output", widget: { name: "active_output" } });
  node.onConfigure();
  assert.equal(node.inputs.length, 1);
  assert.equal(node.inputs[0].label.trim(), "");
  assert.equal(node.outputs[0].label.trim(), "");
  assert.deepEqual(Array.from(node.size), [42, 52]);
  assert.deepEqual(Array.from(node.outputs[1].pos), [42, 36]);
  const second = new Node();
  second.onNodeCreated();
  assert.equal(badgeStyles.length, 1);
});

test("routing honors selection through chained switches and detects blocked upstream routes", () => {
  const context = vm.createContext({});
  vm.runInContext(routing, context);
  const prompt = {
    save: { class_type: "SaveVideo" },
    first: { class_type: "ElvaxRerouteSwitch", inputs: { value: ["save", 0], active_output: "A" } },
    second: { class_type: "ElvaxRerouteSwitch", inputs: { value: ["first", 0], active_output: "B" } },
  };
  assert.equal(context.isActiveRoute(prompt, ["second", 1]), true);
  assert.equal(context.isActiveRoute(prompt, ["second", 0]), false);
  prompt.first.inputs.active_output = "B";
  assert.equal(context.isActiveRoute(prompt, ["second", 1]), false);
  prompt.first.inputs.active_output = "A";
  prompt.first.inputs.value = ["second", 1];
  assert.equal(context.isActiveRoute(prompt, ["second", 1]), false);
});

test("inactive optional routes are omitted for any node while required branches and workflow links stay intact", async () => {
  const prompt = {
    workflow: { links: [[1, 2, 0, 3, 0], [2, 2, 1, 3, 1]] },
    output: {
      source: { class_type: "SaveVideo", inputs: {} },
      route: { class_type: "ElvaxRerouteSwitch", inputs: { active_output: "B", value: ["source", 0] } },
      consumer: { class_type: "AnyOptionalConsumer", inputs: { first: ["route", 0], second: ["route", 1] } },
      other: { class_type: "SaveVideo", inputs: { video: ["route", 0] } },
    },
  };
  const app = { graphToPrompt: async () => structuredClone(prompt), registerExtension(extension) { this.extension = extension; } };
  app.canvas = Object.create({ renderLink() {} });
  const context = vm.createContext({ app, LiteGraph: { registered_node_types: {
    AnyOptionalConsumer: { nodeData: { input: { optional: { first: [], second: [] } } } },
  } } });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replaceAll("export ", ""), context);
  app.extension.setup();
  const result = await app.graphToPrompt();
  assert.equal(result.output.consumer.inputs.first, undefined);
  assert.deepEqual(result.output.consumer.inputs.second, ["route", 1]);
  assert.deepEqual(result.output.other.inputs.video, ["route", 0]);
  assert.deepEqual(result.workflow.links, prompt.workflow.links);
  assert.deepEqual(prompt.output.consumer.inputs.first, ["route", 0]);
});
