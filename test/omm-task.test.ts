/**
 * 任务复选框解析与切换
 */

import assert from "node:assert/strict"
import { taskOf, toggleTaskText } from "../src/omm/core/task"

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

console.log("omm task")

test("[ ] 是未完成", () => {
  assert.deepEqual(taskOf("[ ] 买牛奶"), { checked: false, rest: "买牛奶" })
})

test("[x] / [X] 是已完成", () => {
  assert.deepEqual(taskOf("[x] 已买"), { checked: true, rest: "已买" })
  assert.deepEqual(taskOf("[X] 已买"), { checked: true, rest: "已买" })
})

test("普通文字不是任务", () => {
  assert.equal(taskOf("买牛奶"), null)
  assert.equal(taskOf("[链接](x) 文字"), null)
})

test("切换勾选状态，文字保持不变", () => {
  assert.equal(toggleTaskText("[ ] 买牛奶"), "[x] 买牛奶")
  assert.equal(toggleTaskText("[x] 买牛奶"), "[ ] 买牛奶")
  assert.equal(toggleTaskText("[X] 买牛奶"), "[ ] 买牛奶")
})

test("非任务文字原样返回", () => {
  assert.equal(toggleTaskText("买牛奶"), "买牛奶")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
