/**
 * 快捷输入词典 + 选中文本转换单测
 */

import assert from "node:assert/strict"
import {
  buildDictionary,
  customCategoryLabels,
  insertionText,
  normalizeCustomDictionary,
} from "../src/core/dictionary"
import { applyTransform, TRANSFORMS } from "../src/core/transform"

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

console.log("dictionary.ts")

test("默认词典有三组内置分类，且全部以 # / 模板形式可用", () => {
  const menu = buildDictionary([])
  assert.equal(menu.groups.length, 2)
  assert.equal(menu.groups[0].categories.length, 3)
  assert.equal(menu.groups[1].categories.length, 3)
  assert.ok(menu.entries.length >= 15)
  assert.ok(menu.entries.every((e) => e.content.trim().length > 0))
  assert.equal(menu.entries[0].source, "builtin")
})

test("自定义条目进入「自定义词典」分组", () => {
  const custom = normalizeCustomDictionary([
    { id: "a", title: "镜头卡", hint: "常用", content: "# 镜头", category: "我的模板" },
    { id: "b", title: "口头禅", content: "嗯。", category: "我的模板" },
  ])
  const menu = buildDictionary(custom)
  assert.equal(custom.length, 2)
  assert.equal(menu.groups.length, 3)
  assert.equal(menu.groups[2].label, "自定义词典")
  assert.deepEqual(customCategoryLabels(custom), ["我的模板"])
  const customEntries = menu.entries.filter((e) => e.source === "custom")
  assert.equal(customEntries.length, 2)
  assert.equal(customEntries[0].category, "custom:我的模板")
})

test("停用的自定义条目不会进入菜单", () => {
  const custom = normalizeCustomDictionary([
    { id: "a", title: "停用", content: "x", category: "通用", enabled: false },
  ])
  const menu = buildDictionary(custom)
  assert.equal(menu.entries.filter((e) => e.source === "custom").length, 0)
  assert.equal(menu.groups.length, 2)
})

test("坏数据被过滤", () => {
  const custom = normalizeCustomDictionary([
    null,
    {},
    { title: "", content: "x" },
    { title: "有标题", content: "   " },
    { title: "有效", content: "#d 内容" },
  ])
  assert.equal(custom.length, 1)
  assert.equal(custom[0].title, "有效")
  assert.equal(custom[0].category, "通用")
})

test("前缀型条目把选中文字接在后面", () => {
  assert.equal(insertionText("#d ", "描述内容"), "#d 描述内容")
  assert.equal(insertionText("#d ", ""), "#d ")
  assert.equal(insertionText("## 镜头\n", "选中"), "## 镜头\n")
})

console.log("transform.ts")

test("包裹类转换", () => {
  assert.equal(applyTransform("bold", "文字"), "**文字**")
  assert.equal(applyTransform("italic", "文字"), "*文字*")
  assert.equal(applyTransform("code", "文字"), "`文字`")
  assert.equal(applyTransform("highlight", "文字"), "==文字==")
  assert.equal(applyTransform("wiki", "文字"), "[[文字]]")
})

test("段首标签包裹与去除", () => {
  assert.equal(applyTransform("tag-s", "场景名"), "#s 场景名")
  assert.equal(applyTransform("tag-d", "描述"), "#d 描述")
  assert.equal(applyTransform("strip-marker", "#s 场景名"), "场景名")
  assert.equal(applyTransform("strip-marker", "/l 台词"), "台词")
  assert.equal(applyTransform("strip-marker", "普通文字"), "普通文字")
})

test("大小写 / 空白 / 智能引号", () => {
  assert.equal(applyTransform("upper", "abc"), "ABC")
  assert.equal(applyTransform("lower", "ABC"), "abc")
  assert.equal(applyTransform("trim", "  文字  "), "文字")
  assert.equal(applyTransform("collapse-blank", "a\n\n\n\nb"), "a\n\nb")
  assert.equal(applyTransform("smart-quotes", '"你好"'), "“你好”")
})

test("转换列表数量与 id 唯一", () => {
  assert.ok(TRANSFORMS.length >= 10)
  const ids = new Set(TRANSFORMS.map((t) => t.id))
  assert.equal(ids.size, TRANSFORMS.length)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
