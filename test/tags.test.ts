/**
 * 标签组系统单测
 */

import assert from "node:assert/strict"
import {
  DEFAULT_TAG_SETTINGS,
  matchTagAtLine,
  normalizeMarker,
  normalizeTagSettings,
  resolveTags,
  validateCustomMarker,
} from "../src/core/tags"

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

console.log("tags.ts")

test("默认两组：语义 + 剧本，所有标记都以 # 开头", () => {
  const tags = resolveTags(DEFAULT_TAG_SETTINGS)
  const semantic = tags.filter((t) => t.group === "semantic")
  const script = tags.filter((t) => t.group === "script")
  assert.equal(semantic.length, 5)
  assert.equal(script.length, 6)
  assert.equal(tags.find((t) => t.marker === "#d")?.label, "描述")
  assert.equal(tags.find((t) => t.marker === "#e")?.label, "例子")
  assert.equal(tags.find((t) => t.marker === "#s")?.label, "场景")
  assert.equal(tags.find((t) => t.marker === "#l")?.label, "对白")
  assert.equal(tags.find((t) => t.marker === "#d")?.color, "#2F6FAF")
  assert.ok(tags.every((t) => t.marker.startsWith("#")))
})

test("剧本段落 #s 可直接匹配，旧写法 /s 作为别名兼容", () => {
  const tags = resolveTags(DEFAULT_TAG_SETTINGS)
  assert.equal(matchTagAtLine("#s 场景正文", tags)?.tag.label, "场景")
  assert.equal(matchTagAtLine("#a 动作描述", tags)?.tag.label, "动作")
  assert.equal(matchTagAtLine("/s 场景正文", tags)?.tag.label, "场景")
  assert.equal(tags.find((t) => t.marker === "#s")?.aliases?.[0], "/s")
})

test("关闭语义组后 #d 不再匹配", () => {
  const tags = resolveTags({ ...DEFAULT_TAG_SETTINGS, semanticEnabled: false })
  assert.equal(matchTagAtLine("#d 描述正文", tags), null)
  assert.ok(matchTagAtLine("#s 场景正文", tags))
})

test("关闭剧本组后 #s 不再匹配", () => {
  const tags = resolveTags({ ...DEFAULT_TAG_SETTINGS, scriptEnabled: false })
  assert.equal(matchTagAtLine("#s 场景正文", tags), null)
  assert.ok(matchTagAtLine("#d 描述正文", tags))
})

test("自定义标签 #o 可匹配，且可单独停用", () => {
  const settings = normalizeTagSettings({
    semanticEnabled: true,
    scriptEnabled: true,
    custom: [{ marker: "#o", label: "观点", color: "#A33F62", enabled: true }],
  })
  const tags = resolveTags(settings)
  const matched = matchTagAtLine("#o 我的观点", tags)
  assert.equal(matched?.tag.label, "观点")
  assert.equal(matched?.tag.group, "custom")
  assert.equal(matched?.tag.color, "#A33F62")

  const off = resolveTags({ ...settings, custom: [{ ...settings.custom[0], enabled: false }] })
  assert.equal(matchTagAtLine("#o 我的观点", off), null)
})

test("标签后必须有空格：不能把 #dear 当成 #d", () => {
  const tags = resolveTags(DEFAULT_TAG_SETTINGS)
  assert.equal(matchTagAtLine("#dear 文本", tags), null)
  assert.ok(matchTagAtLine("#d 文本", tags))
  assert.ok(matchTagAtLine("#d", tags))
})

test("长标记优先：#abc 不会被 #ab 截断", () => {
  const settings = normalizeTagSettings({
    custom: [
      { marker: "#ab", label: "AB", color: "#000000", enabled: true },
      { marker: "#abc", label: "ABC", color: "#000000", enabled: true },
    ],
  })
  const tags = resolveTags(settings)
  assert.equal(matchTagAtLine("#abc 内容", tags)?.tag.label, "ABC")
  assert.equal(matchTagAtLine("#ab 内容", tags)?.tag.label, "AB")
})

test("自定义符号校验：保留字 / 重复 / 非法", () => {
  const base = normalizeTagSettings({})
  assert.ok(validateCustomMarker("#d", base)?.includes("官方"))
  assert.ok(validateCustomMarker("#s", base)?.includes("官方"))
  assert.ok(validateCustomMarker("/s", base)?.includes("#"))
  assert.ok(validateCustomMarker("o", base)?.includes("#"))
  assert.ok(validateCustomMarker("#", base) !== null)
  const withCustom = normalizeTagSettings({
    custom: [{ marker: "#o", label: "观点", color: "#fff", enabled: true }],
  })
  assert.ok(validateCustomMarker("#o", withCustom)?.includes("已经存在"))
  assert.equal(validateCustomMarker("#new", withCustom), null)
})

test("normalizeTagSettings 过滤坏数据并补默认值", () => {
  const normalized = normalizeTagSettings({
    custom: [
      { marker: "#o", label: "", color: "bad" },
      { marker: "bad", label: "无效", color: "#fff" },
    ],
  })
  assert.equal(normalized.custom.length, 1)
  assert.equal(normalized.custom[0].marker, "#o")
  assert.equal(normalized.custom[0].label, "#o")
  assert.match(normalized.custom[0].color, /^#/)
  assert.equal(normalizeMarker("#o"), "#o")
  assert.equal(normalizeMarker("bad"), "")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
