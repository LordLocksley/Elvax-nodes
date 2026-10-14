import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxJSONPromptSplitter";
const BUILDER_TYPE = "ElvaxJSONPromptBuilder";
const MAX_PROMPTS = 32;
const MIN_HEIGHT = 130;
const SLOT_HEIGHT = 22;

function isNode(node, type) {
  return node?.type === type || node?.comfyClass === type;
}

function widgetValue(node, name) {
  return node?.widgets?.find((widget) => widget.name === name)?.value;
}

function linkSource(node, input) {
  if (input?.link == null) return null;
  const link = node.graph?.links?.[input.link];
  return link ? node.graph?.getNodeById(link.origin_id) : null;
}

function setName(node) {
  return String(widgetValue(node, "Constant") ?? "").trim();
}

function builderForSource(node, visited = new Set()) {
  if (!node || visited.has(node)) return null;
  visited.add(node);
  if (isNode(node, BUILDER_TYPE)) return node;

  if (node.type === "Reroute" || node.comfyClass === "Reroute") {
    return builderForSource(node.graph?.getNodeById(node.graph?.links?.[node.inputs?.[0]?.link]?.origin_id), visited);
  }

  if (node.type === "GetNode" || node.comfyClass === "GetNode") {
    const name = setName(node);
    const setter = (node.graph?._nodes || []).find((candidate) =>
      (candidate.type === "SetNode" || candidate.comfyClass === "SetNode") && setName(candidate) === name,
    );
    return builderForSource(linkSource(setter, setter?.inputs?.[0]), visited);
  }
  return null;
}

function sourceVideoCount(node) {
  const input = node.inputs?.find((item) => item.name === "json_string");
  const linkedBuilder = builderForSource(linkSource(node, input));
  const builders = (node.graph?._nodes || []).filter((candidate) => isNode(candidate, BUILDER_TYPE));
  const builder = linkedBuilder || (builders.length === 1 ? builders[0] : null);
  const value = Number(widgetValue(builder, "video_count"));
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_PROMPTS, Math.floor(value))) : 0;
}

function requiredHeight(node) {
  return Math.max(MIN_HEIGHT, 40 + Math.max(node.inputs?.length || 0, node.outputs?.length || 0) * SLOT_HEIGHT);
}

function syncOutputs(node) {
  const previousOutputCount = node.outputs.length;
  const count = sourceVideoCount(node);
  while (node.outputs.length > count) {
    if (node.outputs.at(-1)?.links?.length) break;
    node.removeOutput(node.outputs.length - 1);
  }
  while (node.outputs.length < count) {
    node.addOutput(`prompt_${node.outputs.length + 1}`, "STRING");
  }
  node.outputs.forEach((output, index) => {
    const name = `prompt_${index + 1}`;
    output.name = name;
    output.label = name;
  });
  if (node.outputs.length > previousOutputCount) {
    const height = requiredHeight(node);
    if (height > node.size[1]) node.setSize([node.size[0], height]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function install(node) {
  if (node.__elvaxJSONPromptSplitterInstalled) return;
  node.__elvaxJSONPromptSplitterInstalled = true;
  const jsonInput = node.inputs?.find((input) => input.name === "json_string");
  if (jsonInput) jsonInput.label = "JSON";
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    this.__elvaxJSONPromptSplitterConfigured = true;
    return originalConfigure?.apply(this, args);
  };
  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    requestAnimationFrame(() => syncOutputs(this));
    return result;
  };
  requestAnimationFrame(() => {
    syncOutputs(node);
    if (node.__elvaxJSONPromptSplitterConfigured) return;
    node.setSize([Math.max(330, node.size[0]), requiredHeight(node)]);
  });
}

app.registerExtension({
  name: "elvax.json-prompt-splitter",
  setup() {
    window.setInterval(() => {
      for (const node of app.graph?._nodes || []) {
        if (isNode(node, NODE_TYPE)) syncOutputs(node);
      }
    }, 150);
  },
  nodeCreated(node) {
    if (isNode(node, NODE_TYPE)) install(node);
  },
  loadedGraphNode(node) {
    if (!isNode(node, NODE_TYPE)) return;
    node.__elvaxJSONPromptSplitterConfigured = true;
    install(node);
    requestAnimationFrame(() => {
      syncOutputs(node);
      node.setSize([node.size[0], requiredHeight(node)]);
    });
  },
});
