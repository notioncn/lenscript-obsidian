/**
 * 列表节点层级：缩进栈（与上游导图一致），而不是「固定 4 空格一级」
 */

import assert from "node:assert/strict"
import { parse } from "../src/omm/core/parser"

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

function depths(source: string, texts: string[]): number[] {
  const tree = parse(source, OPTS)
  return texts.map((text) => {
    for (const node of tree.byId.values()) if (node.text === text) return node.depth
    throw new Error(`找不到节点 ${text}`)
  })
}

console.log("omm list depth")

test("2 空格缩进也能正确嵌套", () => {
  const source = ["# 根", "", "- 一", "  - 一甲", "    - 一甲一", "  - 一乙", "- 二", ""].join("\n")
  assert.deepEqual(depths(source, ["一", "一甲", "一甲一", "一乙", "二"]), [2, 3, 4, 3, 2])
})

test("Tab 缩进与多空格混用", () => {
  // Tab 记 4 列；子级用「Tab + 2 空格」= 6 列，仍比父级深
  const source = ["# 根", "", "- 一", "\t- 一甲", "\t  - 一甲一", "\t- 一乙", ""].join("\n")
  assert.deepEqual(depths(source, ["一", "一甲", "一甲一", "一乙"]), [2, 3, 4, 3])
})

test("有序列表 1. 同样按缩进嵌套", () => {
  const source = ["# 根", "", "1. 第一", "  1. 第一点一", "  2. 第一点二", "2. 第二", ""].join("\n")
  assert.deepEqual(depths(source, ["第一", "第一点一", "第一点二", "第二"]), [2, 3, 3, 2])
})

test("无序 / 有序同缩进视为同级", () => {
  const source = ["# 根", "", "- 甲", "1. 乙", "  - 乙一", ""].join("\n")
  assert.deepEqual(depths(source, ["甲", "乙", "乙一"]), [2, 2, 3])
})

test("- [ ] 待办项是节点，不是正文", () => {
  const source = ["# 根", "", "- [ ] 买牛奶", "- [x] 已完成的", ""].join("\n")
  const tree = parse(source, OPTS)
  const milk = [...tree.byId.values()].find((node) => node.text === "[ ] 买牛奶")
  assert.ok(milk, "待办应成为节点")
  assert.equal(milk.depth, 2)
})

test("同级回退：回到父级缩进后深度收回", () => {
  const source = ["# 根", "", "- 一", "  - 一甲", "- 二", ""].join("\n")
  assert.deepEqual(depths(source, ["一", "一甲", "二"]), [2, 3, 2])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
