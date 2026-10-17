import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const REROUTE_SWITCH = "ElvaxRerouteSwitch";
export const CIRCUIT_SWITCH = "ElvaxCircuitSwitch";
export const ROUTE_CHANGED = "elvax.reroute_switch.changed";

let switchLayoutInstalled = false;

export function ensureSwitchLayout() {
  if (switchLayoutInstalled) return;
  switchLayoutInstalled = true;
  const route = `.lg-node:has([node-type="${REROUTE_SWITCH}"])`;
  const circuit = `.lg-node:has([node-type="${CIRCUIT_SWITCH}"])`;
  const both = `:is(${route}, ${circuit})`;
  const style = document.createElement("style");
  style.textContent = `
    ${both} { min-width: 0 !important; min-height: 0 !important; --min-node-width: 0px !important; }
    [data-elvax-switch-toolbar] { transform: translate(-50%, -100%) !important; transition: opacity .12s ease !important; animation: none !important; }
    ${route} { width: 42px !important; height: 52px !important; }
    ${circuit} { width: 72px !important; height: 40px !important; }
    ${both} [data-testid="node-inner-wrapper"] { width: 100% !important; min-width: 0 !important; height: 100%; border-radius: ${LiteGraph.ROUND_RADIUS}px; }
    ${both} [data-testid^="node-body-"] { position: relative; height: 100%; padding: 0 !important; gap: 0 !important; border-radius: inherit; background: inherit; }
    ${both} [data-testid^="node-body-"] > .mt-auto { display: none !important; }
    ${both} [data-testid^="node-body-"] > .flex.justify-between { position: absolute; inset: 0; pointer-events: none; }
    ${both} .lg-slot { position: absolute; height: 0; padding: 0 !important; pointer-events: auto; z-index: 2; }
    ${both} .lg-slot--input { left: 0; }
    ${both} .lg-slot--output { right: 0; }
    ${route} .lg-slot--input { top: 26px; }
    ${route} .lg-slot--output { top: 16px; }
    ${route} .lg-slot--output + .lg-slot--output { top: 36px; }
    ${circuit} .lg-slot { top: 20px; }
    ${both} .lg-node-widgets { position: absolute; inset: 0; display: block !important; padding: 0 !important; pointer-events: none; }
    ${both} .lg-node-widget { display: block !important; height: 100%; }
    ${both} .lg-node-widget > :first-child { display: none !important; }
    ${both} [node-type] { display: block !important; width: 100%; height: 100%; pointer-events: none; }
    ${route} [node-type] button { pointer-events: auto; }
    ${circuit} [node-type] button::after { content: ""; position: absolute; inset: 4px 18px; pointer-events: auto; }
    ${circuit} [data-elvax-circuit] { display: block !important; }
    ${circuit}:has([data-elvax-closed="true"]) [data-slot-key] { background: #46d994 !important; }
    ${circuit}:has([data-elvax-closed="false"]) [data-slot-key] { background: #777b80 !important; }
    ${route}:has([data-elvax-route="A"]) .lg-slot--output + .lg-slot--output [data-slot-key],
    ${route}:has([data-elvax-route="B"]) .lg-slot--output:first-child [data-slot-key] { background: #4c4e52 !important; }
  `;
  document.head.append(style);
  keepSwitchToolbarAbove();
}

function keepSwitchToolbarAbove() {
  let toolbar = null;
  let observedParent = null;
  let observedNode = null;
  const positionObserver = new MutationObserver(update);
  const nodeObserver = new MutationObserver(update);
  function update() {
    const current = document.querySelector('[data-testid="selection-toolbox"]');
    if (current !== toolbar) {
      toolbar?.style.removeProperty("translate");
      toolbar?.removeAttribute("data-elvax-switch-toolbar");
      toolbar = current;
    }
    const parent = toolbar?.parentElement;
    if (parent !== observedParent) {
      positionObserver.disconnect();
      if (parent) positionObserver.observe(parent, { attributes: true, attributeFilter: ["style"] });
      observedParent = parent;
    }
    if (!toolbar) {
      nodeObserver.disconnect();
      observedNode = null;
      return;
    }
    const selected = Object.values(app.canvas?.selected_nodes || {});
    const node = LiteGraph.vueNodesMode && selected.length === 1 &&
      [REROUTE_SWITCH, CIRCUIT_SWITCH].includes(selected[0]?.comfyClass)
      ? document.querySelector(`.lg-node[data-node-id="${selected[0].id}"]`) : null;
    if (node !== observedNode) {
      nodeObserver.disconnect();
      if (node) {
        nodeObserver.observe(node, { attributes: true, attributeFilter: ["style"] });
        nodeObserver.observe(node.parentElement, { attributes: true, attributeFilter: ["style"] });
      }
      observedNode = node;
    }
    if (!node) {
      toolbar.style.removeProperty("translate");
      toolbar.removeAttribute("data-elvax-switch-toolbar");
      return;
    }
    toolbar.toggleAttribute("data-elvax-switch-toolbar", true);
    const outline = node.querySelector('[data-testid="node-state-outline-overlay"]') || node;
    const offset = outline.getBoundingClientRect().top - 8 - parent.getBoundingClientRect().top;
    const translate = `0 ${offset}px`;
    if (toolbar.style.translate !== translate) toolbar.style.translate = translate;
  }
  const selectionObserver = new MutationObserver(update);
  selectionObserver.observe(document.querySelector(".graph-canvas-container"), { childList: true, subtree: true });
  update();
}

export function selectedOutput(node) {
  return node.widgets?.find((widget) => widget.name === "active_output")?.value === "B" ? 1 : 0;
}

export function isActiveRoute(prompt, link) {
  const visited = new Set();
  while (Array.isArray(link) && link.length === 2) {
    const source = prompt[link[0]];
    if (visited.has(source)) return false;
    visited.add(source);
    if (source?.class_type === CIRCUIT_SWITCH) {
      if (source.inputs.closed !== true) return false;
      link = source.inputs.value;
      continue;
    }
    if (source?.class_type !== REROUTE_SWITCH) return true;
    if (link[1] !== (source.inputs.active_output === "B" ? 1 : 0)) return false;
    link = source.inputs.value;
  }
  return true;
}

function install(node) {
  ensureSwitchLayout();
  node.hideSlotLabels = true;
  node.drawBadges = () => {};
  node.resizable = false;
  node.widgets_start_y = 6;
  node.computeSize = () => [42, 52];
  function layout() {
    const switchInput = node.inputs.findIndex((input) => input.widget?.name === "active_output");
    if (switchInput !== -1) node.removeInput(switchInput);
    node.size = [42, 52];
    node.inputs[0].pos = [0, 26];
    // Empty labels fall back to the socket name in both native renderers.
    node.inputs[0].label = " ";
    node.outputs.forEach((output, slot) => {
      output.pos = [42, 16 + slot * 20];
      output.label = " ";
    });
  }
  layout();
  const original = node.widgets.find((widget) => widget.name === "active_output");
  let value = original.value;
  const index = node.widgets.indexOf(original);
  node.widgets.splice(index, 1);
  const root = document.createElement("div");
  root.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;user-select:none;";
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("role", "switch");
  control.setAttribute("aria-label", "Use lower output instead of upper output");
  control.style.cssText = `position:relative;flex:none;width:22px;height:40px;padding:0;border:1px solid #73777d;border-radius:${LiteGraph.ROUND_RADIUS}px;background:#292b2e;box-shadow:inset 0 1px 2px #0008,0 1px 1px #ffffff12;cursor:pointer;outline:none;box-sizing:border-box;`;
  const indicator = document.createElement("span");
  indicator.style.cssText = `position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:${Math.max(0, LiteGraph.ROUND_RADIUS - 4)}px;background:linear-gradient(145deg,#f1f2f3,#c5c8cb);box-shadow:0 1px 3px #0009,inset 0 1px #fff;transition:transform .16s ease;pointer-events:none;`;
  control.append(indicator);
  root.append(control);
  function refresh() {
    const active = value === "B" ? 1 : 0;
    root.setAttribute("data-elvax-route", value);
    control.setAttribute("aria-checked", String(active === 1));
    control.title = `${active ? "Lower" : "Upper"} output is active. Click to switch outputs.`;
    indicator.style.transform = active ? "translateY(18px)" : "translateY(0)";
    node.outputs.forEach((output, slot) => {
      if (slot === active) {
        delete output.color_on;
        delete output.color_off;
      } else {
        output.color_on = output.color_off = "#4c4e52";
      }
    });
    node.graph?.setDirtyCanvas(true, true);
    api.dispatchEvent(new CustomEvent(ROUTE_CHANGED));
  }
  const widget = node.addDOMWidget("active_output", "custom", root, {
    socketless: true,
    getValue: () => value,
    setValue: (selected) => { value = selected === "B" ? "B" : "A"; refresh(); },
    getMinHeight: () => 40,
    getMaxHeight: () => 40,
  });
  widget.computeLayoutSize = () => ({ minWidth: 22, minHeight: 40, maxHeight: 40 });
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    node.graph?.beforeChange();
    widget.value = value === "A" ? "B" : "A";
    node.graph?.afterChange();
  });
  const oldConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = oldConfigure?.apply(this, arguments);
    layout();
    refresh();
    return result;
  };
  const oldConnections = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = oldConnections?.apply(this, arguments);
    refresh();
    return result;
  };
  layout();
  refresh();
}

app.registerExtension({
  name: "Elvax.RerouteSwitch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== REROUTE_SWITCH) return;
    nodeType.title_mode = LiteGraph.NO_TITLE;
    const oldCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = oldCreated?.apply(this, arguments);
      install(this);
      return result;
    };
  },
  setup() {
    const graphToPrompt = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
      const prompt = await graphToPrompt.apply(this, args);
      for (const node of Object.values(prompt.output)) {
        const optional = LiteGraph.registered_node_types[node.class_type]?.nodeData?.input?.optional;
        for (const input of Object.keys(optional || {})) {
          if (!isActiveRoute(prompt.output, node.inputs[input])) delete node.inputs[input];
        }
      }
      return prompt;
    };
    const prototype = Object.getPrototypeOf(app.canvas);
    const renderLink = prototype.renderLink;
    prototype.renderLink = function (...args) {
      const link = args[3];
      const source = link && this.graph?.getNodeById(link.origin_id);
      const inactiveCircuit = source?.comfyClass === CIRCUIT_SWITCH && source.widgets?.find((widget) => widget.name === "closed")?.value === false;
      const inactiveRoute = source?.comfyClass === REROUTE_SWITCH && link.origin_slot !== selectedOutput(source);
      if (inactiveCircuit || inactiveRoute) {
        args[5] = 0;
        args[6] = "#4c4e52";
      }
      return renderLink.apply(this, args);
    };
  },
});
