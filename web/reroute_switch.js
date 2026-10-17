import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const REROUTE_SWITCH = "ElvaxRerouteSwitch";
export const CIRCUIT_SWITCH = "ElvaxCircuitSwitch";
export const ROUTE_CHANGED = "elvax.reroute_switch.changed";

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
