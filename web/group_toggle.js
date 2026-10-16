import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const HIDDEN_FLAG = "elvaxToggleHidden";
const WIDTH = 44;
const HEIGHT = 16;
const MARGIN = 6;

function shown(group) {
  return !group.flags[HIDDEN_FLAG];
}

function bounds(group) {
  return [group.pos[0] + group.size[0] - WIDTH - MARGIN,
    group.pos[1] + (group.titleHeight - HEIGHT) / 2, WIDTH, HEIGHT];
}

function contains(rect, x, y) {
  return x >= rect[0] && y >= rect[1] && x <= rect[0] + rect[2] && y <= rect[1] + rect[3];
}

function headerAt(canvas, x, y) {
  if (!canvas.graph || canvas.graph.getNodeOnPos(x, y)) return null;
  return [...canvas.graph.groups].reverse().find((group) => group.isPointInTitlebar(x, y)) || null;
}

function groupNodes(group) {
  const rect = group.boundingRect;
  return group.graph.nodes.filter((node) => {
    const b = node.boundingRect;
    return contains(rect, b[0] + b[2] / 2, b[1] + b[3] / 2);
  });
}

function groupState(group) {
  const nodes = groupNodes(group);
  if (!nodes.length) return "empty";
  if (nodes.every((node) => node.mode === 4)) return "off";
  if (nodes.every((node) => node.mode === 0)) return "on";
  return "mixed";
}

function changeGroup(canvas, change) {
  canvas.emitBeforeChange();
  change();
  canvas.graph.change();
  canvas.emitAfterChange();
  canvas.setDirty(true, true);
}

function visibilityItem(canvas, group) {
  return {
    content: shown(group) ? "Hide Group Bypass Switch" : "Show Group Bypass Switch",
    callback: () => changeGroup(canvas, () => {
      if (shown(group)) group.flags[HIDDEN_FLAG] = true;
      else delete group.flags[HIDDEN_FLAG];
    }),
  };
}

function toggleGroup(canvas, group) {
  group.recomputeInsideNodes();
  if (!group.nodes.length) return;
  const mode = group.nodes.every((node) => node.mode === 4) ? 0 : 4;
  changeGroup(canvas, () => {
    const pending = [...group.nodes];
    while (pending.length) {
      const node = pending.pop();
      node.mode = mode;
      if (node.isSubgraphNode?.()) pending.push(...node.subgraph.nodes);
    }
  });
}

function drawToggle(ctx, group, alpha) {
  const [x, y, width, height] = bounds(group);
  const state = groupState(group);
  const active = state === "on";
  const mixed = state === "mixed";
  ctx.save();
  ctx.globalAlpha = alpha * (state === "empty" ? .5 : 1);
  ctx.fillStyle = active ? "#009b67" : mixed ? "#795523" : "#333b46";
  ctx.strokeStyle = active ? "#2ceba1" : mixed ? "#e7b75a" : "#77818f";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f1f5f9";
  ctx.beginPath();
  ctx.arc(active ? x + width - height / 2 : mixed ? x + width / 2 : x + height / 2,
    y + height / 2, 5.25, 0, Math.PI * 2);
  ctx.fill();
  if (mixed) {
    ctx.strokeStyle = "#795523";
    ctx.beginPath();
    ctx.moveTo(x + width / 2 - 3, y + height / 2);
    ctx.lineTo(x + width / 2 + 3, y + height / 2);
    ctx.stroke();
  } else {
    ctx.font = "bold 8px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(active ? "ON" : "OFF", active ? x + 16 : x + 28, y + height / 2 + .5);
  }
  ctx.restore();
}

app.registerExtension({
  name: "Elvax.GroupToggle",

  async setup() {
    // Install after extension setup so this also encloses rgthree's group drawing.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    let drawing = null;
    let pointerHeader = null;
    let pressed = null;
    const extensions = await api.getExtensions();
    const rgthreeFeature = extensions.find((url) => url.endsWith("/feature_group_fast_toggle.js"));
    if (rgthreeFeature) {
      const { SERVICE } = await import(new URL("./services/config_service.js", new URL(rgthreeFeature, location.href)).href);
      const getFeatureValue = SERVICE.getFeatureValue;
      SERVICE.getFeatureValue = function (key, fallback) {
        const value = getFeatureValue.call(this, key, fallback);
        if (key !== "group_header_fast_toggle.enabled" || !value) return value;
        if (!drawing && pointerHeader && shown(pointerHeader)) return false;
        if (drawing && !drawing.clipped) {
          // rgthree checks this after native headers are drawn. Clip only its overlay.
          drawing.clipped = true;
          const { canvas, ctx } = drawing;
          const area = canvas.visible_area;
          for (const group of canvas.graph.groups) {
            if (!shown(group)) continue;
            ctx.beginPath();
            ctx.rect(area[0] - 1, area[1] - 1, area[2] + 2, area[3] + 2);
            ctx.rect(group.pos[0], group.pos[1], group.size[0], group.titleHeight);
            ctx.clip("evenodd");
          }
        }
        return value;
      };
    }

    const drawGroups = LGraphCanvas.prototype.drawGroups;
    LGraphCanvas.prototype.drawGroups = function (element, ctx) {
      ctx.save();
      const previous = drawing;
      drawing = { canvas: this, ctx, clipped: false };
      try { drawGroups.apply(this, arguments); }
      finally { drawing = previous; ctx.restore(); }
      for (const group of this.graph?.groups || []) {
        if (shown(group)) drawToggle(ctx, group, this.editor_alpha);
      }
    };

    function pointerTarget(event) {
      const canvas = app.canvas;
      if (event.target !== canvas.canvas) return null;
      canvas.adjustMouseEvent(event);
      const group = headerAt(canvas, event.canvasX, event.canvasY);
      if (!group) return null;
      const inToggleRegion = contains(bounds(group), event.canvasX, event.canvasY);
      return { canvas, group, inToggleRegion, overToggle: shown(group) && inToggleRegion };
    }

    function consume(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    window.addEventListener("pointerdown", (event) => {
      const target = pointerTarget(event);
      pointerHeader = target?.group || null;
      if (!target || event.button === 1) return;
      if (!target.overToggle && !(event.button === 2 && target.inToggleRegion)) return;
      consume(event);
      if (event.button === 2) {
        new LiteGraph.ContextMenu([visibilityItem(target.canvas, target.group)], { event });
      } else if (event.button === 0) {
        pressed = { ...target, pointerId: event.pointerId };
      }
    }, true);

    window.addEventListener("pointerup", (event) => {
      pointerHeader = null;
      if (!pressed || event.pointerId !== pressed.pointerId) return;
      const original = pressed;
      pressed = null;
      const target = pointerTarget(event);
      consume(event);
      if (target?.group === original.group && target.overToggle) toggleGroup(target.canvas, target.group);
    }, true);

    window.addEventListener("pointercancel", (event) => {
      pointerHeader = null;
      if (pressed?.pointerId === event.pointerId) pressed = null;
    }, true);
    for (const type of ["click", "dblclick", "contextmenu"]) {
      window.addEventListener(type, (event) => {
        const target = pointerTarget(event);
        if (target?.overToggle || (type === "contextmenu" && target?.inToggleRegion)) consume(event);
      }, true);
    }

    let hovering = false;
    let oldTitle = "";
    let oldCursor = "";
    app.canvas.canvas.addEventListener("pointermove", (event) => {
      const target = pointerTarget(event);
      const element = app.canvas.canvas;
      if (target?.overToggle && !event.buttons) {
        if (!hovering) { oldTitle = element.title; oldCursor = element.style.cursor; }
        hovering = true;
        element.style.cursor = "pointer";
        const state = groupState(target.group);
        element.title = state === "on" ? "Enabled — click to bypass group" : state === "off"
          ? "Bypassed — click to enable group" : state === "empty" ? "This group is empty"
            : "Some nodes are disabled — click to bypass group";
      } else if (hovering) {
        hovering = false;
        element.title = oldTitle;
        element.style.cursor = oldCursor;
      }
    });
  },

  getCanvasMenuItems(canvas) {
    const group = headerAt(canvas, canvas.graph_mouse[0], canvas.graph_mouse[1]);
    return group ? [visibilityItem(canvas, group)] : [];
  },
});
