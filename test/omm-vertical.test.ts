/**
 * 向下组织图（org-down）的布局、连线与落点测试
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { edgePath } from "../src/omm/view/Connectors"
import { hitTest } from "../src/omm/view/DragController"
import { layout } from "../src/omm/layout"
import type { Box } from "../src/omm/layout/types"

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

const SOURCE = [
  "# 根",
  "",
  "## A",
  "",
  "### A1",
  "",
  "### A2",
  "",
  "## B",
  "",
  "## C",
  "",
].join("\n")

const OPTS = { strictLineBreak: false, listNodes: false, orderedListNodes: false, deepListMarker: "-" }

/** 固定尺寸：宽 = 字数 * 8 + 24，高 28。布局测试只关心几何关系。 */
const measure = (node: { text: string }) => ({ w: node.text.length * 8 + 24, h: 28 })

function build() {
  const tree = parse(SOURCE, OPTS)
  const boxes = layout(tree, {
    direction: "right",
    structure: "org-down",
    hGap: 24,
    vGap: 16,
    rootGap: 40,
    measure,
  })
  return { tree, boxes }
}

function byText(tree: ReturnType<typeof parse>, text: string) {
  for (const node of tree.byId.values()) if (node.text === text) return node
  throw new Error(`找不到节点 ${text}`)
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

console.log("omm vertical layout")

test("子节点在父节点下方，且按文档顺序从左到右", () => {
  const { tree, boxes } = build()
  const root = boxes.get(byText(tree, "根").id)!
  const a = boxes.get(byText(tree, "A").id)!
  const b = boxes.get(byText(tree, "B").id)!
  const c = boxes.get(byText(tree, "C").id)!
  assert.ok(a.y > root.y + root.h - 0.01, "A 应在根下方")
  assert.ok(b.y > root.y + root.h - 0.01, "B 应在根下方")
  assert.ok(a.x < b.x && b.x < c.x, "A/B/C 应从左到右")
})

test("父节点在整块子节点上方居中", () => {
  const { tree, boxes } = build()
  const root = boxes.get(byText(tree, "根").id)!
  const descendants = ["A", "A1", "A2", "B", "C"].map((text) => boxes.get(byText(tree, text).id)!)
  const minX = Math.min(...descendants.map((box) => box.x))
  const maxX = Math.max(...descendants.map((box) => box.x + box.w))
  const rootCenter = root.x + root.w / 2
  const blockCenter = (minX + maxX) / 2
  assert.ok(Math.abs(rootCenter - blockCenter) < 0.01, `根中心 ${rootCenter} ≠ 子块中心 ${blockCenter}`)
})

test("同层节点不重叠，父子之间留出 vGap", () => {
  const { tree, boxes } = build()
  const all = [...boxes.values()]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!
      const b = all[j]!
      assert.ok(!overlaps(a, b), `矩形重叠: ${JSON.stringify(a)} / ${JSON.stringify(b)}`)
    }
  }
  const root = boxes.get(byText(tree, "根").id)!
  const a = boxes.get(byText(tree, "A").id)!
  assert.ok(Math.abs(a.y - (root.y + root.h + 16)) < 0.01, "父子间距应等于 vGap")
})

test("孙节点在子节点下方，而不是和子节点同一层", () => {
  const { tree, boxes } = build()
  const a = boxes.get(byText(tree, "A").id)!
  const a1 = boxes.get(byText(tree, "A1").id)!
  assert.ok(a1.y > a.y + a.h, "A1 应在 A 下方")
})

test("向下连线的起点在父底边中点、终点在子顶边中点", () => {
  const from = { x: 0, y: 0, w: 100, h: 40 }
  const to = { x: 20, y: 80, w: 60, h: 30 }
  const straight = edgePath(from, to, "straight", "v")
  assert.equal(straight, "M50 40L50 80")
  const curve = edgePath(from, to, "curve", "v")
  assert.ok(curve.startsWith("M50 40C50 60 50 60 50 80"), curve)
  const elbow = edgePath(from, to, "elbow", "v")
  assert.ok(elbow.startsWith("M50 40"), elbow)
  assert.ok(elbow.endsWith("50 80"), elbow)
})

test("向下布局的拖拽落点按左右分区", () => {
  const boxes = new Map([["a", { x: 100, y: 100, w: 100, h: 40 }]])
  assert.equal(hitTest(["a"], boxes, 110, 120, "v").zone, "before")
  assert.equal(hitTest(["a"], boxes, 150, 120, "v").zone, "into")
  assert.equal(hitTest(["a"], boxes, 190, 120, "v").zone, "after")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
