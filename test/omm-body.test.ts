/**
 * OMM 节点正文（备注）的读取与写回测试
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { applyPlan } from "../src/omm/core/editplan"
import { bodyTextOf, hasBody, setBody } from "../src/omm/core/tree"

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

/** 与应用默认设置一致：列表不单独成节点，列表行算上一节点的正文 */
const OPTS = { strictLineBreak: false, listNodes: false, orderedListNodes: false, deepListMarker: "-" }

const SOURCE = [
  "# 中心主题",
  "",
  "## 第一场",
  "",
  "#s 开场便利店",
  "深夜 24 小时，便利店的灯还亮着。",
  "- 一盒烟，还有火吗？",
  "",
  "#a 推门进店",
  "",
  "## 第二场",
  "",
  "#x 切至天台",
  "雨停了。",
  "",
].join("\n")

type Node = ReturnType<typeof parse>["root"]

function find(node: Node, text: string): Node | null {
  if (node.text.includes(text)) return node
  for (const child of node.children) {
    const hit = find(child, text)
    if (hit) return hit
  }
  return null
}

function nodeOf(text: string) {
  const tree = parse(SOURCE, OPTS)
  const node = find(tree.root, text)
  assert.ok(node, `找不到节点 ${text}`)
  return { tree, node }
}

console.log("omm body text")

test("正文 = 标题行与下一个节点之间的行（列表行也算正文）", () => {
  const { tree, node } = nodeOf("开场便利店")
  assert.ok(hasBody(tree, node))
  assert.equal(bodyTextOf(tree, node), "深夜 24 小时，便利店的灯还亮着。\n- 一盒烟，还有火吗？")
})

test("没有正文的节点返回空串", () => {
  const { tree, node } = nodeOf("推门进店")
  assert.equal(hasBody(tree, node), false)
  assert.equal(bodyTextOf(tree, node), "")
})

test("改写正文：只动正文行，标题与子节点不变", () => {
  const { tree, node } = nodeOf("开场便利店")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, "新的正文\n第二行")).join("\n")
  assert.ok(out.includes("#s 开场便利店\n新的正文\n第二行\n"), "正文应被整体替换")
  assert.ok(!out.includes("深夜 24 小时"), "旧正文应消失")
  assert.ok(out.includes("## 第二场"), "后面的节点不能丢")
})

test("空正文节点插入正文：紧跟在标题行之后", () => {
  const { tree, node } = nodeOf("推门进店")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, "推门，风铃响了一声。")).join("\n")
  assert.ok(out.includes("#a 推门进店\n推门，风铃响了一声。\n"), "正文应插在标题下一行")
})

test("正文改成空串 = 删掉正文，保留节点", () => {
  const { tree, node } = nodeOf("开场便利店")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, "")).join("\n")
  assert.ok(out.includes("#s 开场便利店"), "标题应保留")
  assert.ok(!out.includes("深夜 24 小时"), "正文应被删除")
  assert.ok(out.includes("#a 推门进店"), "兄弟节点应保留")
})

test("正文写回后再解析，内容一致且不重复", () => {
  const { tree, node } = nodeOf("开场便利店")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, "改写后的正文")).join("\n")
  const again = parse(out, OPTS)
  const next = find(again.root, "开场便利店")
  assert.ok(next)
  assert.equal(bodyTextOf(again, next), "改写后的正文")
})

test("不改正文时 setBody 原样来回，一个字节都不差", () => {
  const { tree, node } = nodeOf("开场便利店")
  const body = bodyTextOf(tree, node)
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, body)).join("\n")
  assert.equal(out, SOURCE)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
