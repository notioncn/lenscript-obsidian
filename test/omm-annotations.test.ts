/**
 * 行尾注解（框 / 概要 / 标注 / 关联线 / 自由主题）的解析与写回测试
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { applyPlan } from "../src/omm/core/editplan"
import { renameNode, setBody, setNodeAnnotations } from "../src/omm/core/tree"
import { annotationKind, serializeAnnotations, splitAnnotations } from "../src/omm/core/annotations"

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

const SOURCE = [
  "# 中心主题",
  "",
  "## 第一场 %%summary=2 \"铺陈氛围\"%%",
  "",
  "### A",
  "",
  "### B",
  "",
  "## 第二场 %%box%%",
  "",
  "### C",
  "",
  "#s 便利店 %%callout \"夜里三点\"%% %%id=r1%%",
  "",
].join("\n")

type Node = ReturnType<typeof parse>["root"]

function find(node: Node, text: string): Node | null {
  if (node.text === text) return node
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

console.log("omm annotations")

test("解析概要：文字被剥离，span / 文字进注解", () => {
  const { node } = nodeOf("第一场")
  assert.equal(node.text, "第一场")
  assert.deepEqual(node.annotations?.summary, { span: 2, text: "铺陈氛围" })
  assert.equal(node.annotationsRaw, ' %%summary=2 "铺陈氛围"%%')
})

test("解析外框：无文字、span 缺省为 1", () => {
  const { node } = nodeOf("第二场")
  assert.deepEqual(node.annotations?.box, { span: 1, text: "" })
})

test("一行多个注解：标注 + 锚点都能拆出来", () => {
  const { node } = nodeOf("便利店")
  assert.equal(node.text, "便利店")
  assert.equal(node.annotations?.callout?.text, "夜里三点")
  assert.equal(node.annotations?.anchor, "r1")
})

test("未知的 %%…%% 不算注解，原样留在文字里", () => {
  const r = splitAnnotations("标题 %%TODO 待办%%")
  assert.equal(r.text, "标题 %%TODO 待办%%")
  assert.equal(r.annotations, null)
})

test("serializeAnnotations 与 splitAnnotations 互逆", () => {
  const r = splitAnnotations('标题 %%box=3 "组"%% %%summary=2 "概要"%% %%callout "标注"%%')
  const again = splitAnnotations("标题" + serializeAnnotations(r.annotations))
  assert.deepEqual(again.annotations, r.annotations)
  assert.equal(again.text, "标题")
})

test("关联线：单向 / 双向都能解析并原样写回", () => {
  const one = splitAnnotations('甲 %%rel=r1 "影响"%%')
  assert.deepEqual(one.annotations?.rels, [{ target: "r1", text: "影响" }])
  const both = splitAnnotations("乙 %%rel=r1 both%%")
  assert.deepEqual(both.annotations?.rels, [{ target: "r1", text: "", both: true }])
  const again = splitAnnotations("乙" + serializeAnnotations(both.annotations))
  assert.deepEqual(again.annotations, both.annotations)
  assert.ok(serializeAnnotations(both.annotations).includes(" both"))
})

test("setNodeAnnotations 只改标题行，文字与子节点不变", () => {
  const { tree, node } = nodeOf("第二场")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setNodeAnnotations(tree, node.id, { rels: [], box: { span: 2, text: "第一幕" } })).join("\n")
  assert.ok(out.includes('## 第二场 %%box=2 "第一幕"%%'), "应写入新外框")
  assert.ok(out.includes("### C"), "子节点不能丢")
  assert.ok(out.includes("## 第一场 %%summary=2 \"铺陈氛围\"%%"), "其它节点的注解不能动")
})

test("清空注解：只去掉行尾尾巴，标题保留", () => {
  const { tree, node } = nodeOf("第二场")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setNodeAnnotations(tree, node.id, null)).join("\n")
  assert.ok(out.includes("## 第二场\n") || out.includes("## 第二场"), "标题保留")
  assert.ok(!out.includes("%%box%%"), "外框应移除")
})

test("改名不丢注解", () => {
  const { tree, node } = nodeOf("第一场")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, renameNode(tree, node.id, "改名后的第一场")).join("\n")
  assert.ok(out.includes('## 改名后的第一场 %%summary=2 "铺陈氛围"%%'), "注解应跟着改名保留")
})

test("写正文不碰标题行注解", () => {
  const { tree, node } = nodeOf("第一场")
  const lines = SOURCE.split("\n")
  const out = applyPlan(lines, setBody(tree, node.id, "新的正文")).join("\n")
  assert.ok(out.includes('## 第一场 %%summary=2 "铺陈氛围"%%'), "标题行注解原样保留")
  assert.ok(out.includes("新的正文"), "正文应写入")
})

test("编辑器只把已知注解画成图标", () => {
  assert.equal(annotationKind('callout "我问问"'), "callout")
  assert.equal(annotationKind('callout "我问问" cc=red'), "callout")
  assert.equal(annotationKind("id=r1"), "anchor")
  assert.equal(annotationKind('rel=r1 "文字" c=0,-80'), "rel")
  assert.equal(annotationKind('box=3 "第一幕"'), "box")
  assert.equal(annotationKind("summary=2"), "summary")
  assert.equal(annotationKind("float x=10 y=-20"), "float")
  assert.equal(annotationKind("这是用户自己的普通注释"), null)
  assert.equal(annotationKind(""), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
