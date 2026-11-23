/**
 * 自由主题（%%float x y%%）的布局测试
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { layout } from "../src/omm/layout"
import { hitTest } from "../src/omm/view/DragController"

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${name}`)
    console.error(e instanceof Error ? e.message : e)
  }
}

const OPTS = { strictLineBreak: false, listNodes: false, orderedListNodes: false, deepListMarker: "-" }

/** 固定尺寸：只取决于标题文字（注解已被剥离），方便对比「加不加 float 注解」的布局差异。 */
const measure = (node: { text: string }) => ({ w: node.text.length * 8 + 24, h: 28 })

const PLAIN = ["# 根", "", "## A", "", "## B", "", "## C", ""].join("\n")
const FLOAT = ["# 根", "", "## A", "", '## B %%float x=200 y=120%%', "", "## C", ""].join("\n")

function build(source: string) {
  const tree = parse(source, OPTS)
  const boxes = layout(tree, { direction: "right", hGap: 24, vGap: 16, rootGap: 40, measure })
  return { tree, boxes }
}

function byText(tree: ReturnType<typeof parse>, text: string) {
  for (const node of tree.byId.values()) if (node.text === text) return node
  throw new Error(`找不到节点 ${text}`)
}

function center(box: { x: number; y: number; w: number; h: number }) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

console.log("omm float layout")

test("自由主题中心 = 父节点中心 + 偏移", () => {
  const { tree, boxes } = build(FLOAT)
  const root = boxes.get(byText(tree, "根").id)!
  const b = boxes.get(byText(tree, "B").id)!
  const expected = center(root)
  const actual = center(b)
  assert.ok(Math.abs(actual.x - (expected.x + 200)) < 0.01, `x ${actual.x} ≠ ${expected.x + 200}`)
  assert.ok(Math.abs(actual.y - (expected.y + 120)) < 0.01, `y ${actual.y} ≠ ${expected.y + 120}`)
})

test("其它兄弟节点不受自由主题影响", () => {
  const plain = build(PLAIN)
  const floated = build(FLOAT)
  for (const text of ["A", "C", "根"]) {
    const a = plain.boxes.get(byText(plain.tree, text).id)!
    const b = floated.boxes.get(byText(floated.tree, text).id)!
    assert.equal(a.x, b.x, `${text} 的 x 不应变化`)
    assert.equal(a.y, b.y, `${text} 的 y 不应变化`)
  }
})

test("自由主题的子树跟着一起平移", () => {
  const source = ["# 根", "", '## B %%float x=200 y=120%%', "", "### B1", ""].join("\n")
  const plain = ["# 根", "", "## B", "", "### B1", ""].join("\n")
  const floated = build(source)
  const base = build(plain)
  const b1 = floated.boxes.get(byText(floated.tree, "B1").id)!
  const b1Base = base.boxes.get(byText(base.tree, "B1").id)!
  const b = floated.boxes.get(byText(floated.tree, "B").id)!
  const bBase = base.boxes.get(byText(base.tree, "B").id)!
  const dx = b.x - bBase.x
  const dy = b.y - bBase.y
  assert.ok(Math.abs((b1.x - b1Base.x) - dx) < 0.01, "子节点应跟随父节点同样的水平位移")
  assert.ok(Math.abs((b1.y - b1Base.y) - dy) < 0.01, "子节点应跟随父节点同样的垂直位移")
})

test("自由拖动排除自己后，能命中指针下面的其他节点", () => {
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>([
    ["self", { x: 0, y: 0, w: 200, h: 40 }],
    ["other", { x: 0, y: 60, w: 200, h: 40 }],
  ])
  // 指针挪到 other 上；不排除自己时永远只会命中自己
  const hit = hitTest(["self", "other"], boxes, 100, 80, "h", new Set(["self"]))
  assert.equal(hit.id, "other")
  assert.equal(hit.zone, "into")
})

test("没有独立节点时 hitTest 行为不变", () => {
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>([
    ["a", { x: 0, y: 0, w: 200, h: 40 }],
  ])
  const hit = hitTest(["a"], boxes, 100, 5, "h")
  assert.equal(hit.id, "a")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
