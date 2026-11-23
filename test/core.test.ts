/**
 * M1 锚点系统纯函数单测
 * 运行：npm test（esbuild 打包后用 node 执行）
 */

import assert from "node:assert/strict"
import {
  findBlockAtLine,
  injectBlockIds,
  normalizeText,
  similarity,
  splitBlocks,
  stripBlockIds,
} from "../src/core/blocks"
import { indexAnchors, resolveAnchor } from "../src/core/anchor"
import {
  applyRepair,
  createNodeRef,
  resolveNodeRef,
  resolveNodeRefs,
} from "../src/core/ref"

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

const SAMPLE = [
  "---",
  "title: 测试",
  "---",
  "",
  "# 标题一",
  "第一段内容。",
  "第二行。",
  "",
  "## 场景 A",
  "/s 场景描述",
  "",
  "- 项目一",
  "  - 嵌套项目",
  "- 项目二",
  "",
  "> 引用内容",
  "> 第二行",
  "",
  "```js",
  "# 不是标题",
  "const x = 1",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n")

console.log("blocks.ts")

test("切分块类型", () => {
  const blocks = splitBlocks(SAMPLE)
  const kinds = blocks.map((b) => b.kind)
  assert.deepEqual(kinds, [
    "frontmatter",
    "heading",
    "paragraph",
    "heading",
    "paragraph",
    "list",
    "list",
    "list",
    "quote",
    "code",
    "table",
  ])
  assert.equal(blocks[1].text, "标题一")
  assert.equal(blocks[1].level, 1)
  assert.equal(blocks[3].text, "场景 A")
  assert.equal(blocks[4].marker, "s")
  assert.equal(blocks[4].text, "场景描述")
  assert.equal(blocks[5].text, "项目一")
  assert.equal(blocks[6].text, "嵌套项目")
})

test("heading 路径", () => {
  const blocks = splitBlocks(SAMPLE)
  assert.deepEqual(blocks[1].headingPath, ["标题一"])
  assert.deepEqual(blocks[3].headingPath, ["标题一", "场景 A"])
  assert.deepEqual(blocks[4].headingPath, ["标题一", "场景 A"])
})

test("代码块内不解析 heading / 块 ID", () => {
  const md = "```\n# 假标题 ^fake\n```\n\n真实段落 ^real"
  const blocks = splitBlocks(md)
  assert.equal(blocks[0].kind, "code")
  assert.equal(blocks[0].blockId, undefined)
  assert.equal(blocks[1].kind, "paragraph")
  assert.equal(blocks[1].blockId, "real")
})

test("行尾块 ID 与独立行块 ID", () => {
  const md = ["## 标题 ^h-1", "", "段落内容。", "^p-2", "", "- 列表项 ^l-3"].join(
    "\n",
  )
  const blocks = splitBlocks(md)
  assert.equal(blocks[0].blockId, "h-1")
  assert.equal(blocks[0].text, "标题")
  assert.equal(blocks[1].blockId, "p-2")
  assert.equal(blocks[1].text, "段落内容。")
  assert.equal(blocks[1].endLine, 2)
  assert.equal(blocks[2].blockId, "l-3")
})

test("findBlockAtLine", () => {
  const blocks = splitBlocks(SAMPLE)
  assert.equal(findBlockAtLine(blocks, 6)?.text, "第一段内容。\n第二行。")
  assert.equal(findBlockAtLine(blocks, 19)?.kind, "code")
  assert.equal(findBlockAtLine(blocks, 99), undefined)
})

test("normalizeText 与 similarity", () => {
  assert.equal(normalizeText("  Hello, **世界**！ "), "hello 世界")
  assert.equal(similarity("今天天气很好", "今天天气很好"), 1)
  assert.ok(similarity("今天天气很好", "今天天气不错") > 0.4)
  assert.ok(similarity("今天天气很好", "完全无关的内容") < 0.2)
})

test("注入块 ID：覆盖可注入块、跳过代码与 frontmatter", () => {
  const result = injectBlockIds(SAMPLE)
  assert.equal(result.injected.length, 9)
  assert.equal(result.injected.some((i) => i.kind === "code"), false)
  assert.equal(result.injected.some((i) => i.kind === "frontmatter"), false)
  const ids = result.injected.map((i) => i.blockId)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => /^ls-[a-z0-9]+$/i.test(id)))
  assert.ok(result.markdown.includes("场景描述 ^ls-"))
  assert.ok(!result.markdown.includes("# 不是标题 ^ls-"))
})

test("注入块 ID 幂等", () => {
  const once = injectBlockIds(SAMPLE)
  const twice = injectBlockIds(once.markdown)
  assert.equal(twice.injected.length, 0)
  assert.equal(twice.markdown, once.markdown)
})

test("只注入指定块", () => {
  const blocks = splitBlocks(SAMPLE)
  const paragraphIndex = blocks.findIndex((b) => b.text.startsWith("第一段"))
  const result = injectBlockIds(SAMPLE, { onlyBlockIndex: paragraphIndex })
  assert.equal(result.injected.length, 1)
  assert.equal(result.injected[0].blockIndex, paragraphIndex)
})

test("stripBlockIds 可移除所有块 ID", () => {
  const injected = injectBlockIds(SAMPLE).markdown
  assert.equal(stripBlockIds(injected), SAMPLE)
})

console.log("anchor.ts")

test("块 ID 命中 → ok", () => {
  const md = injectBlockIds(SAMPLE).markdown
  const index = indexAnchors(md)
  const block = index.blocks.find((b) => b.text === "场景描述")!
  assert.ok(block.blockId)

  const result = resolveAnchor(index, {
    blockId: block.blockId,
    fingerprint: block.fingerprint,
    headingPath: block.headingPath,
    offsetHint: block.startLine,
  })
  assert.equal(result.status, "ok")
  assert.equal(result.confidence, 1)
  assert.equal(result.contentChanged, false)
})

test("块 ID 命中但正文修改 → ok + contentChanged", () => {
  const md = "段落内容 ^a-1"
  const index = indexAnchors(md)
  const result = resolveAnchor(index, {
    blockId: "a-1",
    fingerprint: "旧的段落内容",
  })
  assert.equal(result.status, "ok")
  assert.equal(result.contentChanged, true)
})

test("块 ID 丢失但文本未变 → moved", () => {
  const md = "第一段内容。\n第二行。"
  const index = indexAnchors(md)
  const result = resolveAnchor(index, {
    blockId: "dead-id",
    fingerprint: normalizeText("第一段内容。\n第二行。"),
    headingPath: ["标题一"],
    offsetHint: 6,
  })
  assert.equal(result.status, "moved")
  assert.ok(result.confidence >= 0.8)
  assert.equal(result.block?.startLine, 0)
})

test("块 ID 丢失且 heading 内文本小改 → moved", () => {
  const md = ["# 章节", "", "原来写的是：今天天气很好。", "", "另一段。"].join(
    "\n",
  )
  const index = indexAnchors(md)
  const result = resolveAnchor(index, {
    blockId: "gone",
    headingPath: ["章节"],
    fingerprint: "原来写的是：今天天气不错。",
    offsetHint: 2,
  })
  assert.equal(result.status, "moved")
  assert.equal(result.block?.text, "原来写的是：今天天气很好。")
  assert.ok(result.confidence >= 0.5)
})

test("内容彻底消失 → broken", () => {
  const md = "# 别的章节\n\n完全无关的正文。"
  const index = indexAnchors(md)
  const result = resolveAnchor(index, {
    blockId: "gone",
    fingerprint: "第一段内容",
    headingPath: ["标题一"],
    offsetHint: 5,
  })
  assert.equal(result.status, "broken")
  assert.equal(result.confidence, 0)
})

test("仅 heading 路径 → 命中唯一标题块", () => {
  const md = "# 标题一\n\n正文\n\n# 标题二"
  const index = indexAnchors(md)
  const result = resolveAnchor(index, { headingPath: ["标题一"] })
  assert.equal(result.status, "moved")
  assert.equal(result.block?.text, "标题一")
})

console.log("ref.ts")

test("createNodeRef / resolveNodeRef → ok", () => {
  const md = injectBlockIds("# 标题\n\n正文内容").markdown
  const index = indexAnchors(md)
  const block = index.blocks.find((b) => b.text === "正文内容")!
  const ref = createNodeRef("note.md", block)

  const resolution = resolveNodeRef(md, ref, index)
  assert.equal(resolution.status, "ok")
  assert.equal(resolution.repaired, null)
  assert.equal(resolution.block?.text, "正文内容")
})

test("引用正文修改后 → repaired 更新指纹", () => {
  const md = "正文内容 ^b-1"
  const index = indexAnchors(md)
  const ref = {
    file: "note.md",
    blockId: "b-1",
    fingerprint: "旧正文",
    offsetHint: 0,
    headingPath: [],
  }
  const resolution = resolveNodeRef(md, ref, index)
  assert.equal(resolution.status, "ok")
  assert.equal(resolution.contentChanged, true)
  assert.ok(resolution.repaired)
  assert.equal(resolution.repaired?.fingerprint, "正文内容")
  assert.equal(applyRepair(ref, resolution), true)
  assert.equal(ref.fingerprint, "正文内容")
})

test("块 ID 被删 → moved 且修复保留旧 ID", () => {
  const md = "# 标题\n\n正文内容"
  const index = indexAnchors(md)
  const ref = {
    file: "note.md",
    blockId: "lost-id",
    fingerprint: "正文内容",
    offsetHint: 2,
    headingPath: ["标题"],
  }
  const resolution = resolveNodeRef(md, ref, index)
  assert.equal(resolution.status, "moved")
  assert.equal(resolution.block?.text, "正文内容")
  assert.equal(resolution.repaired?.blockId, "lost-id")
})

test("批量解析与断链标记", () => {
  const md = "# 标题\n\n正文内容 ^c-1"
  const index = indexAnchors(md)
  const okBlock = index.blocks.find((b) => b.text === "正文内容")!
  const refs = [
    createNodeRef("note.md", okBlock),
    { file: "note.md", blockId: "nope", fingerprint: "不存在的文本" },
  ]
  const results = resolveNodeRefs(md, refs)
  assert.equal(results[0].status, "ok")
  assert.equal(results[1].status, "broken")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
