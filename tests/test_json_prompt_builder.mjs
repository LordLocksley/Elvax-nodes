import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/json_prompt_builder.js", import.meta.url), "utf8")
  .replace(/^import .*\r?\n/, "");
const context = vm.createContext({ app: { registerExtension() {} } });
vm.runInContext(source, context);
const builder = vm.runInContext("({ FIELD_COLORS, normalizeField, parseBuilderData, objectFromRows, fieldFromValue, pointerSegment })", context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("wrapping defaults on for new and unspecified builder state", () => {
  for (const value of ["", "[]", '{"fields":[]}', "invalid"]) {
    assert.equal(builder.parseBuilderData(value).wrapValues, true);
  }
});

test("explicit saved wrapping choices are preserved", () => {
  for (const wrapValues of [false, true]) {
    assert.equal(builder.parseBuilderData(JSON.stringify({ fields: [], wrapValues })).wrapValues, wrapValues);
  }
});

test("new nodes start at 900px wide without shrinking larger widths", () => {
  for (const width of [300, 1200]) {
    const node = {
      size: [width, 200],
      computeSize: () => [width, 200],
      setSize(size) { this.size = size; },
    };
    const layoutContext = vm.createContext({ node, DEFAULT_NODE_WIDTH: 900, updateRootWidth() {} });
    const start = source.indexOf("  const initialSize = node.computeSize();");
    const end = source.indexOf("  const originalConfigure", start);
    vm.runInContext(source.slice(start, end), layoutContext);
    assert.equal(node.size[0], Math.max(width, 900));
  }
});

function heightLayout(height, content, width = 640) {
  const changes = [];
  const node = {
    size: [width, height],
    setSize(size) { this.size = size; changes.push(size); },
  };
  const layoutContext = vm.createContext({ node, domWidget: { last_y: 90 }, contentHeight: () => content });
  const start = source.indexOf("  function updateMinimumNodeSize() {");
  const end = source.indexOf("\n  const initialSize", start);
  vm.runInContext(`${source.slice(start, end)}\nupdateMinimumNodeSize();`, layoutContext);
  return { node, changes };
}

test("builder shrinks excess height after collapsing or removing fields", () => {
  const { node, changes } = heightLayout(1000, 200);
  assert.deepEqual(plain(node.size), [640, 300]);
  assert.equal(changes.length, 1);
});

test("builder grows to fit added or expanded fields without changing width", () => {
  const { node } = heightLayout(300, 600, 800);
  assert.deepEqual(plain(node.size), [800, 700]);
});

test("builder does not resize when its height already fits", () => {
  assert.equal(heightLayout(300, 200).changes.length, 0);
});

test("palette contains 32 unique colors", () => {
  assert.equal(builder.FIELD_COLORS.length, 32);
  assert.equal(new Set(builder.FIELD_COLORS).size, 32);
  assert.ok(builder.FIELD_COLORS.every((color) => /^#[0-9a-f]{6}$/.test(color)));
});

test("workflow state retains colors after renaming and reordering fields", () => {
  const fields = [
    { key: "renamed", type: "string", value: "text", color: "#3b82f6" },
    { key: "other", type: "number", value: "3", color: "#ef4444" },
  ].reverse();
  const restored = builder.parseBuilderData(JSON.stringify({ fields }));
  assert.equal(restored.rows[0].key, "other");
  assert.equal(restored.rows[0].color, "#ef4444");
  assert.equal(restored.rows[1].color, "#3b82f6");
});

test("saved metadata restores nested fields, array items, and hidden colors", () => {
  const rows = [builder.normalizeField({
    key: "group/name", type: "object", color: "#ef4444", expanded: true,
    value: [
      { key: "value~one", type: "string", value: "text", color: "#3b82f6" },
      { key: "items", type: "array", value: [
        { type: "string", value: "visible", color: "#22c55e" },
        { type: "string", value: "hidden", hidden: true, color: "#ec4899" },
      ] },
    ],
  })];
  const hiddenFields = [];
  const fieldColors = {};
  const json = builder.objectFromRows(rows, "root", "", true, hiddenFields, fieldColors);
  assert.deepEqual(fieldColors, {
    "/group~1name": "#ef4444",
    "/group~1name/value~0one": "#3b82f6",
    "/group~1name/items/0": "#22c55e",
    "/group~1name/items/1": "#ec4899",
  });
  const restored = builder.fieldFromValue("group/name", json["group/name"], "/group~1name", new Set(hiddenFields), fieldColors);
  assert.equal(restored.color, "#ef4444");
  assert.equal(restored.value[0].color, "#3b82f6");
  assert.equal(restored.value[1].value[1].color, "#ec4899");
  assert.equal(restored.value[1].value[1].hidden, true);
  assert.deepEqual(plain(builder.objectFromRows([restored])), {
    "group/name": { "value~one": "text", items: ["visible"] },
  });
});

test("old files load without colors and unsupported colors are ignored", () => {
  assert.equal(builder.fieldFromValue("old", "text", "/old", new Set()).color, "");
  assert.equal(builder.normalizeField({ key: "invalid", color: "red;display:none" }).color, "");
});

test("None uses the original styling and adds no color metadata", () => {
  const field = builder.normalizeField({ key: "plain", type: "string", value: "text", color: "" });
  const fieldColors = {};
  builder.objectFromRows([field], "root", "", true, [], fieldColors);
  assert.equal(field.color, "");
  assert.deepEqual(fieldColors, {});
});
