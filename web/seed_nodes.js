import { app } from "/scripts/app.js";

const STAGE_SEED = "ElvaxStageSeed";
const CHAIN_SEED = "ElvaxChainSeed";
const MAX_SEED = 1125899906842624;

function stageSeeds(graph = app.graph, found = [], visited = new Set()) {
  if (!graph || visited.has(graph)) return found;
  visited.add(graph);
  for (const node of graph.nodes || graph._nodes || []) {
    if (node.comfyClass === STAGE_SEED) found.push(node);
    if (node.isSubgraphNode?.()) stageSeeds(node.subgraph, found, visited);
  }
  return found;
}

function containedStageSeeds(node) {
  return node.isSubgraphNode?.() ? stageSeeds(node.subgraph) : [];
}

function seedWidget(node) {
  return node.widgets?.find((widget) => widget.name === "seed");
}

function stageModeWidget(node) {
  return node.widgets?.find((widget) => widget.name === "mode");
}

function chainModeWidget(node) {
  return node.widgets?.find((widget) => widget.name === "mode");
}

function refreshNode(node) {
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function setBooleanValue(node, widget, value) {
  if (!widget) return;
  const changed = widget.value !== value;
  widget.value = value;
  if (changed) widget.callback?.call(widget, value, app.canvas, node);
  refreshNode(node);
}

function distinctSeeds(nodes, reserved = new Set()) {
  const used = new Set(reserved);
  return nodes.map(() => {
    let seed;
    do {
      seed = Math.floor(Math.random() * (MAX_SEED + 1));
    } while (used.has(seed));
    used.add(seed);
    return seed;
  });
}

function setRandomize(nodes, enabled) {
  nodes.forEach((node) => {
    setBooleanValue(node, stageModeWidget(node), enabled);
  });
}

function assignSeeds(nodes, fixed) {
  const selected = new Set(nodes);
  const reserved = new Set(stageSeeds()
    .filter((node) => !selected.has(node))
    .map((node) => Number(seedWidget(node)?.value)));
  const seeds = distinctSeeds(nodes, reserved);
  nodes.forEach((node, index) => {
    const widget = seedWidget(node);
    if (!widget) return;
    const control = stageModeWidget(node);
    if (control && fixed) setBooleanValue(node, control, false);
    widget.value = seeds[index];
    refreshNode(node);
  });
}

function setFixedSeed(node) {
  assignSeeds([node], true);
}

function installStageSeed(node) {
  const legacyMode = node.properties?.elvaxSeedMode;
  if (legacyMode === "random" && stageModeWidget(node)) stageModeWidget(node).value = true;
  if (node.properties) delete node.properties.elvaxSeedMode;
  if (node.__elvaxStageSeedInstalled) return;
  node.__elvaxStageSeedInstalled = true;
  node.addWidget("button", "New Fixed", null, () => setFixedSeed(node), { serialize: false });
}

function installChainSeed(node) {
  if (node.__elvaxChainSeedInstalled) return;
  node.__elvaxChainSeedInstalled = true;
  const control = chainModeWidget(node);
  if (control && !control.__elvaxRandomizeAllHook) {
    const originalCallback = control.callback;
    control.callback = function (...args) {
      const enabled = typeof args[0] === "boolean" ? args[0] : control.value === true;
      control.value = enabled;
      setRandomize(stageSeeds(), enabled);
      return originalCallback?.apply(this, args);
    };
    control.__elvaxRandomizeAllHook = true;
  }
  node.addWidget("button", "New Fixed", null, () => {
    const allControl = chainModeWidget(node);
    setBooleanValue(node, allControl, false);
    setRandomize(stageSeeds(), false);
    assignSeeds(stageSeeds(), true);
    refreshNode(node);
  }, { serialize: false });
}

function installSubgraphSeedButton(node) {
  if (!node.isSubgraphNode?.() || node.__elvaxSubgraphSeedButtonInstalled) return;
  if (!containedStageSeeds(node).length) return;
  node.__elvaxSubgraphSeedButtonInstalled = true;
  const button = node.addWidget("button", "New Fixed", null, () => {
    assignSeeds(containedStageSeeds(node), true);
  }, { serialize: false });
  const actionWidget = button || node.widgets?.[node.widgets.length - 1];
  if (!actionWidget) return;
  actionWidget.__elvaxSubgraphSeedButton = true;
  moveSubgraphSeedButton(node, node.properties?.elvaxSubgraphSeedButtonPosition);
}

function subgraphSeedButton(node) {
  return node.widgets?.find((widget) => widget.__elvaxSubgraphSeedButton);
}

function moveSubgraphSeedButton(node, position) {
  const widgets = node.widgets;
  const button = subgraphSeedButton(node);
  if (!widgets || !button) return;
  const currentIndex = widgets.indexOf(button);
  if (currentIndex < 0) return;
  widgets.splice(currentIndex, 1);
  const index = position === undefined || position === null
    ? widgets.length
    : Math.max(0, Math.min(Number(position) || 0, widgets.length));
  widgets.splice(index, 0, button);
  node.properties ||= {};
  node.properties.elvaxSubgraphSeedButtonPosition = index;
  node.setDirtyCanvas?.(true, true);
}

async function chooseSubgraphSeedButtonPosition(node) {
  const button = subgraphSeedButton(node);
  if (!button) return;
  const lastPosition = Math.max(1, node.widgets.length);
  const currentPosition = node.widgets.indexOf(button) + 1;
  const value = await app.extensionManager.dialog.prompt({
    title: "Reorder New Fixed",
    message: `Choose its position among this node's controls (1–${lastPosition}).`,
    defaultValue: String(currentPosition),
  });
  if (value === null || value === undefined || value === "") return;
  const position = Number.parseInt(value, 10);
  if (!Number.isFinite(position)) return;
  moveSubgraphSeedButton(node, position - 1);
}

function installSubgraphSeedButtons(graph = app.graph, visited = new Set()) {
  if (!graph || visited.has(graph)) return;
  visited.add(graph);
  for (const node of graph.nodes || graph._nodes || []) {
    if (!node.isSubgraphNode?.()) continue;
    installSubgraphSeedButton(node);
    installSubgraphSeedButtons(node.subgraph, visited);
  }
}

app.registerExtension({
  name: "elvax.seed-nodes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const install = nodeData.name === STAGE_SEED
      ? installStageSeed
      : nodeData.name === CHAIN_SEED
        ? installChainSeed
        : null;
    if (!install) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      install(this);
      return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalConfigured?.apply(this, args);
      install(this);
      return result;
    };
  },
  async setup() {
    const originalGraphToPrompt = app.graphToPrompt;
    if (!originalGraphToPrompt || originalGraphToPrompt.__elvaxSeedHook) return;
    const graphToPrompt = async function (...args) {
      const randomNodes = stageSeeds().filter((node) => stageModeWidget(node)?.value === true);
      if (randomNodes.length) assignSeeds(randomNodes, false);
      return originalGraphToPrompt.apply(this, args);
    };
    graphToPrompt.__elvaxSeedHook = true;
    app.graphToPrompt = graphToPrompt;
  },
  nodeCreated(node) {
    if (node.comfyClass === STAGE_SEED) installSubgraphSeedButtons();
    installSubgraphSeedButton(node);
  },
  loadedGraphNode(node) {
    installSubgraphSeedButton(node);
  },
  getNodeMenuItems(node) {
    if (!subgraphSeedButton(node)) return [];
    return [{
      content: "Reorder New Fixed…",
      callback: () => chooseSubgraphSeedButtonPosition(node),
    }];
  },
  async afterConfigureGraph() {
    installSubgraphSeedButtons();
  },
});
