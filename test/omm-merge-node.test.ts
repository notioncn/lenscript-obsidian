/**
 * 合并到任意节点（拖拽落点菜单的「合并到备注 / 合二为一」）
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"
import { applyPlan } from "../src/omm/core/editplan"
import { mergeIntoNode } from "../src/omm/core/tree"

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
  "# 根",
  "",
  "## 甲",
  "",
  "### 甲一",
  "",
  "## 乙",
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

function ids(text: string) {
  const tree = parse(SOURCE, OPTS)
  const node = find(tree.root, text)
  assert.ok(node, `找不到 ${text}`)
  return { tree, node }
}

console.log("omm merge into arbitrary node")

test("合并到备注：文字落到目标正文，源节点删除", () => {
  const { tree } = ids("甲")
  const source = find(tree.root, "甲一")!
  const target = find(tree.root, "乙")!
  const out = applyPlan(SOURCE.split("\n"), mergeIntoNode(tree, source.id, target.id, "note")).join("\n")
  assert.ok(out.includes("## 乙\n甲一"), "甲一应成为乙的正文")
  assert.ok(!out.includes("### 甲一"), "源节点标题应消失")
  assert.ok(out.includes("## 甲"), "甲的其它内容保留")
})

test("合二为一：源文字接在目标标题后", () => {
  const { tree } = ids("甲")
  const source = find(tree.root, "甲一")!
  const target = find(tree.root, "乙")!
  const out = applyPlan(SOURCE.split("\n"), mergeIntoNode(tree, source.id, target.id, "text")).join("\n")
  assert.ok(out.includes("## 乙 甲一"), "标题应合并")
  assert.ok(!out.includes("### 甲一"), "源节点应消失")
})

test("有子节点的源节点拒绝合并", () => {
  const { tree } = ids("甲")
  const target = find(tree.root, "乙")!
  assert.throws(() => mergeIntoNode(tree, find(tree.root, "根")!.id, target.id, "note"))
})

test("不能合并进自己的子树", () => {
  const { tree } = ids("甲")
  const source = find(tree.root, "甲")!
  const target = find(tree.root, "甲一")!
  assert.throws(() => mergeIntoNode(tree, source.id, target.id, "note"))
})

test("合并后再解析：目标只有一份内容，不重复", () => {
  const { tree } = ids("甲")
  const source = find(tree.root, "甲一")!
  const target = find(tree.root, "乙")!
  const out = applyPlan(SOURCE.split("\n"), mergeIntoNode(tree, source.id, target.id, "note")).join("\n")
  const again = parse(out, OPTS)
  const b = find(again.root, "乙")!
  assert.equal((out.match(/甲一/g) ?? []).length, 1, "甲一只应出现一次")
  assert.ok(b.children.length === 0, "乙不应多出子节点")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
