import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/circuit_switch.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("export ", "");

function createSwitch(vueNodesEnabled) {
  const app = {
    registerExtension(extension) { this.extension = extension; },
  };
  const document = {
    createElement() { return element(); },
    createElementNS() { return element(); },
  };
  const context = vm.createContext({
    app,
    document,
    api: { dispatchEvent() {} },
    CustomEvent: class {},
    CIRCUIT_SWITCH: "ElvaxCircuitSwitch",
    ROUTE_CHANGED: "route-changed",
    ensureSwitchLayout() {},
    LiteGraph: { NO_TITLE: 1, vueNodesMode: vueNodesEnabled },
  });
  vm.runInContext(source, context);
  class Node {
    widgets = [{ name: "closed", value: true }];
    inputs = [{ name: "value" }, { name: "closed", widget: { name: "closed" } }];
    outputs = [{ name: "output" }];
    size = [72, 40];
    removeInput(index) { this.inputs.splice(index, 1); }
    addDOMWidget(name, type, root, options) {
      const widget = { name, root, get value() { return options.getValue(); }, set value(value) { options.setValue(value); } };
      this.widgets.push(widget);
      return widget;
    }
  }
  app.extension.beforeRegisterNodeDef(Node, { name: "ElvaxCircuitSwitch" });
  const node = new Node();
  node.onNodeCreated();
  return { node, control: node.widgets[0].root.children[0], renderer: context.LiteGraph };
}

function element() {
  return {
    style: {}, attributes: {}, children: [], listeners: {},
    append(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
}

test("Circuit Switch renders its state in Vue Nodes while preserving the LiteGraph drawing path", () => {
  const legacy = createSwitch(false);
  const legacySvg = legacy.control.children[0];
  assert.equal(legacySvg.attributes["data-elvax-circuit"], "");
  const legacyDraw = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} };
  legacy.node.onDrawForeground(legacyDraw);
  assert.equal(legacy.node.inputs[0].color_on, "#46d994");

  const vue = createSwitch(true);
  const svg = vue.control.children[0];
  assert.equal(svg.attributes["data-elvax-circuit"], "");
  assert.equal(svg.children.length, 5);
  assert.equal(svg.children[1].attributes.d, "M24 20 H48");
  let drew = false;
  vue.node.onDrawForeground({ save() { drew = true; } });
  assert.equal(drew, false);
  vue.control.listeners.click({ stopPropagation() {} });
  assert.equal(vue.node.widgets[0].value, false);
  assert.equal(svg.children[1].attributes.d, "M24 20 L48 8");
  assert.equal(vue.node.widgets[0].root.attributes["data-elvax-closed"], "false");
  vue.renderer.vueNodesMode = false;
  vue.node.onDrawForeground(legacyDraw);
  assert.equal(vue.node.widgets[0].value, false);
  vue.renderer.vueNodesMode = true;
  assert.doesNotThrow(() => vue.node.onDrawForeground({}));
});
