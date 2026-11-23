/**
 * 外框 / 概要的布局间距：框与框外的兄弟之间要多留出一段，避免框压到节点
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { layout } from "../src/omm/layout"

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

const OPTS = { strictLineBreak: false, listNodes: true, orderedListNodes: true, deepListMarker: "-" }
const measure = (node: { text: string }) => ({ w: node.text.length * 8 + 24, h: 28 })

const V_GAP = 16
const PAD = 10

function build(source: string) {
  const tree = parse(source, OPTS)
  const boxes = layout(tree, { direction: "right", hGap: 24, vGap: V_GAP, rootGap: 40, measure })
  return { tree, boxes }
}

function byText(tree: ReturnType<typeof parse>, text: string) {
  for (const node of tree.byId.values()) if (node.text === text) return node
  throw new Error(`找不到节点 ${text}`)
}

console.log("omm box spacing")

test("框与框外的兄弟之间多留 2×留白", () => {
  const source = ["# 根", "", "## A", "", '## B %%box=2%%', "", "## C", "", "## D", ""].join("\n")
  const { tree, boxes } = build(source)
  const a = boxes.get(byText(tree, "A").id)!
  const b = boxes.get(byText(tree, "B").id)!
  const c = boxes.get(byText(tree, "C").id)!
  const d = boxes.get(byText(tree, "D").id)!
  assert.equal(Math.round(b.y - (a.y + a.h)), V_GAP + PAD * 2, "框的上边界应多留")
  assert.equal(Math.round(c.y - (b.y + b.h)), V_GAP, "框内兄弟保持普通间距")
  assert.equal(Math.round(d.y - (c.y + c.h)), V_GAP + PAD * 2, "框的下边界应多留")
})

test("没有框时保持普通间距", () => {
  const source = ["# 根", "", "## A", "", "## B", "", "## C", ""].join("\n")
  const { tree, boxes } = build(source)
  const a = boxes.get(byText(tree, "A").id)!
  const b = boxes.get(byText(tree, "B").id)!
  assert.equal(Math.round(b.y - (a.y + a.h)), V_GAP)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
