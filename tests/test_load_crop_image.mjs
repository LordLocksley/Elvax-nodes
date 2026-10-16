import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/load_crop_image.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "");
const plain = value => JSON.parse(JSON.stringify(value));

function previewContext(crop = null, rotation = 0) {
  const media = [];
  const changes = [];
  const persisted = [];
  class Media {
    constructor() { media.push(this); }
    addEventListener(name, callback) { this[name] = callback; }
  }
  const context = vm.createContext({
    app: { registerExtension() {} }, Image: Media,
    document: { createElement: () => new Media() },
    source: null, imageWidth: 0, imageHeight: 0, viewRect: null,
    selection: null, appliedCrop: null, initialSizeApplied: true,
    rotation, rotationWidget: { value: rotation },
    imageWidget: { value: "first.png" },
    readAppliedCrop: () => crop, resizeCanvas() {},
    setCropWidgets: crop => changes.push(crop),
    persistPastedImage: (...args) => persisted.push(args),
  });
  vm.runInContext(source, context);
  context.setRotation = value => {
    context.rotation = value;
    context.rotationWidget.value = value;
  };
  vm.runInContext("viewUrl = value => value", context);
  const start = source.indexOf("  function loadPreview(resetCrop) {");
  const end = source.indexOf("\n  domWidget.computeLayoutSize", start);
  vm.runInContext(source.slice(start, end), context);
  return { context, media, changes, persisted, load: (resetCrop = false) => vm.runInContext(`loadPreview(${resetCrop})`, context) };
}

test("late image load and error cannot overwrite the newer preview", () => {
  const { context, media, load } = previewContext();
  load();
  context.imageWidget.value = "second.png";
  load();
  Object.assign(media[1], { naturalWidth: 800, naturalHeight: 600 });
  media[1].onload();
  Object.assign(media[0], { naturalWidth: 200, naturalHeight: 100 });
  media[0].onload();
  media[0].onerror();
  assert.equal(context.source, media[1]);
  assert.deepEqual([context.imageWidth, context.imageHeight], [800, 600]);
});

test("reloading the same filename still ignores older callbacks", () => {
  const { context, media, load, persisted } = previewContext();
  load();
  load();
  media[0].onerror();
  media[0].onload();
  assert.equal(context.source, media[1]);
  assert.equal(persisted.length, 0);
});

test("late video load and error cannot overwrite the current image", () => {
  const { context, media, load } = previewContext();
  context.imageWidget.value = "first.mp4";
  load();
  context.imageWidget.value = "second.png";
  load();
  Object.assign(media[0], { videoWidth: 1920, videoHeight: 1080 });
  media[0].loadeddata();
  media[0].onerror();
  assert.equal(context.source, media[1]);
  assert.equal(context.imageWidth, 0);
});

test("restored crop is clamped and saved to widgets consistently", () => {
  const { context, media, load, changes } = previewContext({ x: 900, y: 700, width: 500, height: 500 });
  load();
  Object.assign(media[0], { naturalWidth: 1000, naturalHeight: 800 });
  media[0].onload();
  const expected = { x: 900, y: 700, width: 100, height: 100 };
  assert.deepEqual(plain(context.viewRect), expected);
  assert.deepEqual(plain(changes[0]), expected);
});

test("crop entirely outside a smaller video becomes a valid one-pixel crop", () => {
  const { context, media, load, changes } = previewContext({ x: 2000, y: 2000, width: 100, height: 100 });
  context.imageWidget.value = "first.mp4";
  load();
  Object.assign(media[0], { videoWidth: 640, videoHeight: 480 });
  media[0].loadeddata();
  assert.deepEqual(plain(context.viewRect), { x: 639, y: 479, width: 1, height: 1 });
  assert.equal(changes.length, 1);
});

test("valid crop and preview dimensions are unchanged", () => {
  const crop = { x: 10, y: 20, width: 400, height: 300 };
  const { context, media, load, changes, persisted } = previewContext(crop);
  load();
  Object.assign(media[0], { naturalWidth: 2000, naturalHeight: 1500 });
  media[0].onload();
  assert.deepEqual(plain(context.viewRect), crop);
  assert.equal(changes.length, 0);
  assert.equal(persisted[0][1], "first.png");
});

test("restored rotation swaps the dimensions before clamping a saved crop", () => {
  const { context, media, load } = previewContext({ x: 700, y: 900, width: 200, height: 300 }, 90);
  load();
  Object.assign(media[0], { naturalWidth: 1000, naturalHeight: 800 });
  media[0].onload();
  assert.deepEqual([context.imageWidth, context.imageHeight], [800, 1000]);
  assert.deepEqual(plain(context.viewRect), { x: 700, y: 900, width: 100, height: 100 });
});

test("choosing a new image clears both rotation and cropping", () => {
  const { context, media, load, changes } = previewContext({ x: 10, y: 20, width: 100, height: 200 }, 270);
  load(true);
  Object.assign(media[0], { naturalWidth: 1000, naturalHeight: 800 });
  media[0].onload();
  assert.equal(context.rotationWidget.value, 0);
  assert.deepEqual(plain(context.viewRect), { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(changes[0], null);
});

test("four rotations preserve the applied crop and return to its original position", () => {
  const { context } = previewContext();
  const rotateCrop = vm.runInContext("rotateCrop", context);
  const original = { x: 100, y: 50, width: 240, height: 100 };
  let crop = original;
  let width = 640;
  let height = 480;
  crop = rotateCrop(crop, height);
  assert.deepEqual(plain(crop), { x: 330, y: 100, width: 100, height: 240 });
  [width, height] = [height, width];
  for (let turn = 1; turn < 4; turn++) {
    crop = rotateCrop(crop, height);
    [width, height] = [height, width];
  }
  assert.deepEqual(plain(crop), original);
});
