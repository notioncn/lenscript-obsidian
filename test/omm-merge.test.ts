/**
 * OMM 合并进父节点（拖动子节点到上一级）的写回测试
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { applyPlan } from "../src/omm/core/editplan"
import { mergeIntoParent } from "../src/omm/core/tree"

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
  "## 分支 A",
  "",
  "#s 开场便利店",
  "深夜 24 小时，便利店的灯还亮着。",
  "",
  "#a 推门进店",
  "",
  "## 分支 B",
  "",
  "#s 追逐戏",
  "",
  "#x 切至天台",
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

function merged(text: string, mode: "note" | "text"): string {
  const tree = parse(SOURCE, OPTS)
  const child = find(tree.root, text)
  assert.ok(child, `找不到节点 ${text}`)
  return applyPlan(SOURCE.split("\n"), mergeIntoParent(tree, child.id, mode)).join("\n")
}

console.log("omm merge into parent")

test("合并为备注：文字落到父节点正文，父节点标题不变", () => {
  const out = merged("切至天台", "note")
  assert.ok(out.includes("## 分支 B"), "父节点标题应保持不变")
  const body = out.split("## 分支 B")[1]
  assert.ok(body.includes("切至天台"), "子节点文字应进入父节点正文")
  assert.ok(!out.includes("#x 切至天台"), "原 marker 行应被删除")
})

test("合二为一：文字接在父节点标题后", () => {
  const out = merged("切至天台", "text")
  assert.ok(out.includes("## 分支 B 切至天台"), "父节点标题应拼接子节点文字")
  assert.ok(!out.includes("#x 切至天台"))
})

test("两种合并都不丢其它节点", () => {
  for (const mode of ["note", "text"] as const) {
    const out = merged("切至天台", mode)
    const again = parse(out, OPTS)
    assert.ok(find(again.root, "追逐戏"), `${mode}: 追逐戏 应保留`)
    assert.ok(find(again.root, "开场便利店"), `${mode}: 开场便利店 应保留`)
    // 备注模式下文字落进父节点正文，不再是独立节点；合二为一下它成了父节点标题的一部分
    assert.ok(out.includes("切至天台"), `${mode}: 文字不应丢失`)
  }
})

test("合并后二次解析仍只有一个 分支 B 节点", () => {
  const again = parse(merged("切至天台", "text"), OPTS)
  let count = 0
  const walk = (n: Node) => {
    if (n.text.startsWith("分支 B")) count++
    n.children.forEach(walk)
  }
  walk(again.root)
  assert.equal(count, 1)
})

test("有子节点的节点拒绝合并", () => {
  const tree = parse(SOURCE, OPTS)
  const parent = find(tree.root, "分支 B")
  assert.ok(parent)
  assert.throws(() => mergeIntoParent(tree, parent.id, "note"), /只能合并/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
