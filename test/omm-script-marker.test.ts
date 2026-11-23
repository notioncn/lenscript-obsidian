/**
 * 标题文字开头的语义标记拆分（`## #e 同类数`）
 */

import assert from "node:assert/strict"
import { scriptMarkerOf } from "../src/omm/core/scriptMarker"

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

console.log("omm script marker")

test("#e 拆成「例子」标记 + 正文", () => {
  assert.deepEqual(scriptMarkerOf("#e 同类数"), { marker: "e", rest: "同类数" })
})

test("#s / #a 等剧本标记同样识别", () => {
  assert.deepEqual(scriptMarkerOf("#s 开场便利店"), { marker: "s", rest: "开场便利店" })
  assert.deepEqual(scriptMarkerOf("#a 推门进店"), { marker: "a", rest: "推门进店" })
})

test("普通标题不误判", () => {
  assert.equal(scriptMarkerOf("同类数"), null)
  assert.equal(scriptMarkerOf("# 标题"), null)
  assert.equal(scriptMarkerOf("#e没有空格"), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
