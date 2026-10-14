import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxPostProcessing";

function installToggle(node, toggleName, label, dependentNames, refresh) {
  const toggle = node.widgets?.find((widget) => widget.name === toggleName);
  const dependents = dependentNames
    .map((name) => node.widgets?.find((widget) => widget.name === name))
    .filter(Boolean);
  if (!toggle || toggle.__elvaxDisableInstalled) return;

  toggle.label = label;
  toggle.__elvaxDisableInstalled = true;
  const update = () => {
    for (const widget of dependents) widget.disabled = !toggle.value;
    refresh();
  };
  const callback = toggle.callback;
  toggle.callback = function (...args) {
    const result = callback?.apply(this, args);
    update();
    return result;
  };
  update();
}

function hideFixedWidget(node, name, value) {
  const widget = node.widgets?.find((item) => item.name === name);
  if (!widget) return;
  widget.value = value;
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
}

function labelAudioInput(node) {
  const input = node.inputs?.find((item) => item.name === "audio_pass");
  if (input) input.label = "audio";
}

function updateBatchSize(node) {
  const mode = node.widgets?.find((widget) => widget.name === "batching_mode");
  const batchSize = node.widgets?.find((widget) => widget.name === "custom_batch_size");
  const dualPass = node.widgets?.find((widget) => widget.name === "dual_pass_rife");
  const interpolate = node.widgets?.find((widget) => widget.name === "interpolate");
  const modeValue = String(mode?.value ?? "").toLowerCase();
  if (mode && ["full sequence", "normal (64)", "low vram (16)", "custom"].includes(modeValue)) {
    mode.value = modeValue;
  }
  if (batchSize) batchSize.disabled = modeValue !== "custom";
  if (dualPass) {
    dualPass.label = "dual_pass_rife";
    dualPass.disabled = !interpolate?.value;
  }
  node.graph?.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "Elvax.PostProcessing",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const optional = nodeData.input?.optional;
    const required = nodeData.input?.required;
    if (!optional?.audio_pass || !required?.images) return;

    const audioInput = optional.audio_pass;
    delete optional.audio_pass;
    const requiredInputs = Object.entries(required);
    requiredInputs.splice(requiredInputs.findIndex(([name]) => name === "images") + 1, 0, ["audio_pass", audioInput]);
    nodeData.input.required = Object.fromEntries(requiredInputs);

    const inputOrder = nodeData.input_order ??= {};
    inputOrder.optional = (inputOrder.optional ?? []).filter((name) => name !== "audio_pass");
    const requiredOrder = (inputOrder.required ?? Object.keys(required)).filter((name) => name !== "audio_pass");
    requiredOrder.splice(Math.max(0, requiredOrder.indexOf("images") + 1), 0, "audio_pass");
    inputOrder.required = requiredOrder;
  },
  nodeCreated(node) {
    if (node.type !== NODE_TYPE && node.comfyClass !== NODE_TYPE) return;
    const refresh = () => node.graph?.setDirtyCanvas(true, true);
    labelAudioInput(node);
    hideFixedWidget(node, "upscale_method", "lanczos");
    installToggle(node, "upscale", "UPSCALE (lanczos)", ["upscale_by"], refresh);
    installToggle(node, "interpolate", "INTERPOLATE (rife49)", ["interpolate_by", "dual_pass_rife"], refresh);
    installToggle(node, "grain", "FILM GRAIN", ["grain_intensity", "saturation_mix"], refresh);
    const mode = node.widgets?.find((widget) => widget.name === "batching_mode");
    if (mode && !mode.__elvaxBatchModeInstalled) {
      mode.__elvaxBatchModeInstalled = true;
      const callback = mode.callback;
      mode.callback = function (...args) {
        const result = callback?.apply(this, args);
        updateBatchSize(node);
        return result;
      };
    }
    updateBatchSize(node);
    if (!node.__elvaxPostProcessingConfigureHook) {
      node.__elvaxPostProcessingConfigureHook = true;
      const onConfigure = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = onConfigure?.apply(this, args);
        requestAnimationFrame(() => {
          labelAudioInput(this);
          updateBatchSize(this);
          for (const [toggleName, names] of [
            ["upscale", ["upscale_by"]],
            ["interpolate", ["interpolate_by", "dual_pass_rife"]],
            ["grain", ["grain_intensity", "saturation_mix"]],
          ]) {
            const enabled = Boolean(this.widgets?.find((widget) => widget.name === toggleName)?.value);
            for (const name of names) {
              const widget = this.widgets?.find((item) => item.name === name);
              if (widget) widget.disabled = !enabled;
            }
          }
          hideFixedWidget(this, "upscale_method", "lanczos");
          refresh();
        });
        return result;
      };
    }
  },
});
