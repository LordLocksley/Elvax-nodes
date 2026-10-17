import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { CIRCUIT_SWITCH, ROUTE_CHANGED, ensureSwitchLayout } from "./reroute_switch.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function install(node) {
  ensureSwitchLayout();
  node.drawBadges = () => {};
  node.resizable = false;
  node.widgets_start_y = 0;
  node.computeSize = () => [72, 40];
  function layout() {
    const switchInput = node.inputs.findIndex((input) => input.widget?.name === "closed");
    if (switchInput !== -1) node.removeInput(switchInput);
    node.size = [72, 40];
    node.inputs[0].pos = [0, 20];
    node.inputs[0].label = " ";
    node.outputs[0].pos = [72, 20];
    node.outputs[0].label = " ";
  }
  layout();
  const original = node.widgets.find((widget) => widget.name === "closed");
  let closed = original.value !== false;
  node.widgets.splice(node.widgets.indexOf(original), 1);

  const root = document.createElement("div");
  root.style.cssText = "width:100%;height:100%;box-sizing:border-box;user-select:none;";
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("role", "switch");
  control.style.cssText = "position:relative;display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:pointer;";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-elvax-circuit", "");
  svg.style.cssText = "display:none;position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
  const leftPath = document.createElementNS(SVG_NS, "path");
  const contactPath = document.createElementNS(SVG_NS, "path");
  const rightPath = document.createElementNS(SVG_NS, "path");
  const contacts = [0, 1].map(() => document.createElementNS(SVG_NS, "circle"));
  for (const shape of [leftPath, contactPath, rightPath, ...contacts]) {
    shape.setAttribute("stroke-linecap", "round");
    shape.setAttribute("stroke-linejoin", "round");
    shape.setAttribute("stroke-width", "2.5");
    shape.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(shape);
  }
  for (const contact of contacts) {
    contact.setAttribute("r", "3.25");
  }
  control.append(svg);
  root.append(control);

  const oldDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    oldDrawForeground?.apply(this, arguments);
    if (LiteGraph.vueNodesMode) return;
    const input = this.inputs[0].pos;
    const output = this.outputs[0].pos;
    const leftContact = this.size[0] / 3;
    const rightContact = this.size[0] * 2 / 3;
    const middle = this.size[1] / 2;
    const stateColor = closed ? "#46d994" : "#777b80";
    ctx.save();
    ctx.strokeStyle = stateColor;
    ctx.fillStyle = closed ? "#18372a" : "#292b2e";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...input);
    ctx.lineTo(leftContact, middle);
    if (closed) ctx.lineTo(rightContact, middle);
    else {
      ctx.moveTo(leftContact, middle);
      ctx.lineTo(rightContact, 8);
    }
    ctx.moveTo(...output);
    ctx.lineTo(rightContact, middle);
    ctx.stroke();
    for (const x of [leftContact, rightContact]) {
      ctx.beginPath();
      ctx.arc(x, middle, 3.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  };

  function refresh() {
    root.setAttribute("data-elvax-closed", String(closed));
    control.setAttribute("aria-label", closed ? "Circuit closed: click to block the feed" : "Circuit open: click to pass the feed");
    control.setAttribute("aria-checked", String(closed));
    control.title = closed ? "Circuit closed. Click to block the feed." : "Circuit open. Click to pass the feed.";
    const stateColor = closed ? "#46d994" : "#777b80";
    const width = Math.max(node.size[0], 1);
    const leftContact = width / 3;
    const rightContact = width * 2 / 3;
    svg.setAttribute("viewBox", `0 0 ${width} 40`);
    leftPath.setAttribute("d", `M0 20 H${leftContact}`);
    contactPath.setAttribute("d", closed ? `M${leftContact} 20 H${rightContact}` : `M${leftContact} 20 L${rightContact} 8`);
    rightPath.setAttribute("d", `M${rightContact} 20 H${width}`);
    for (const [index, contact] of contacts.entries()) {
      contact.setAttribute("cx", String(index === 0 ? leftContact : rightContact));
      contact.setAttribute("cy", "20");
      contact.setAttribute("stroke", stateColor);
      contact.setAttribute("fill", closed ? "#18372a" : "#292b2e");
    }
    for (const path of [leftPath, contactPath, rightPath]) {
      path.setAttribute("stroke", stateColor);
      path.setAttribute("fill", "none");
    }
    node.inputs[0].color_on = node.inputs[0].color_off = stateColor;
    node.outputs[0].color_on = node.outputs[0].color_off = stateColor;
    node.graph?.setDirtyCanvas(true, true);
    api.dispatchEvent(new CustomEvent(ROUTE_CHANGED));
  }
  const widget = node.addDOMWidget("closed", "custom", root, {
    socketless: true,
    getValue: () => closed,
    setValue: (value) => { closed = value !== false; refresh(); },
    getMinHeight: () => 40,
    getMaxHeight: () => 40,
  });
  widget.computeLayoutSize = () => ({ minWidth: 52, minHeight: 40, maxHeight: 40 });
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    node.graph?.beforeChange();
    widget.value = !closed;
    node.graph?.afterChange();
  });
  const oldConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = oldConfigure?.apply(this, arguments);
    layout();
    refresh();
    return result;
  };
  const oldResize = node.onResize;
  node.onResize = function () {
    const result = oldResize?.apply(this, arguments);
    refresh();
    return result;
  };
  layout();
  refresh();
}

app.registerExtension({
  name: "Elvax.CircuitSwitch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== CIRCUIT_SWITCH) return;
    nodeType.title_mode = LiteGraph.NO_TITLE;
    const oldCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = oldCreated?.apply(this, arguments);
      install(this);
      return result;
    };
  },
});
