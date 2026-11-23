/**
 * gogoga-mindmap 内核集成测试：Markdown ⇄ 树 ⇄ Markdown
 */

import assert from "node:assert/strict"
import {
  addChild,
  addSibling,
  allChildren,
  pathOf,
  walkAll,
  type MindDoc,
  type MindNode,
} from "../src/mindmap/upstream/model"
import {
  parseMarkdown,
  serializeMarkdown,
  DEFAULT_STYLE,
} from "../src/mindmap/upstream/markdown"

/** pathOf 是下标路径；测试里按文字找节点更方便 */
function findNode(root: MindNode, text: string): MindNode | null {
  let found: MindNode | null = null
  walkAll(root, (n) => {
    if (n.text === text) found = n
  })
  return found
}

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

const CANONICAL = [
  "---",
  "mindmap: true",
  "---",
  "",
  "# 中心主题",
  "%%w=504%%",
  "",
  "这张图本身是一篇普通的 Markdown 笔记。",
  "",
  "## 分支 A",
  "%%green fold%%",
  "",
  "### 子主题",
  "",
  "- 列表项一 ^abc123",
  "- 列表项二",
  "",
  "## 分支 B",
  "",
  "- 另一项",
  "",
].join("\n")

console.log("mindmap markdown")

test("规范脑图 Markdown 逐字往返", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  assert.equal(serializeMarkdown(doc), CANONICAL)
})

test("解析：H1 → 根，H2/H3 → 子节点，列表 → 更深节点", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  assert.equal(doc.root.text, "中心主题")
  assert.equal(doc.rootFromHeading, true)
  const branchA = findNode(doc.root, "分支 A")
  assert.ok(branchA)
  assert.equal(branchA!.folded, true)
  assert.equal(branchA!.color, "green")
  const sub = findNode(doc.root, "子主题")
  assert.ok(sub)
  assert.deepEqual(allChildren(sub!).map((n) => n.text), ["列表项一", "列表项二"])
  assert.equal(allChildren(sub!)[0].blockId, "abc123")
})

test("笔记正文与节点备注保留", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  assert.ok(doc.root.note.includes("普通的 Markdown 笔记"))
})

test("添加子节点后序列化包含新节点", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  const branchB = findNode(doc.root, "分支 B")!
  const added = addChild(branchB, doc.style, "新子节点")
  assert.equal(added.parent, branchB)
  const md = serializeMarkdown(doc)
  assert.ok(md.includes("新子节点"))
  // 原有块 ID 不丢
  assert.ok(md.includes("^abc123"))
  // 再解析，结构仍成立
  const again = parseMarkdown(md, { fallbackTitle: "中心主题" })
  assert.ok(findNode(again.root, "新子节点"))
})

test("添加兄弟节点后序列化包含新节点", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  const sub = findNode(doc.root, "子主题")!
  const sibling = addSibling(sub, "子主题的兄弟")
  assert.ok(sibling)
  const md = serializeMarkdown(doc)
  assert.ok(md.includes("子主题的兄弟"))
  const again = parseMarkdown(md, { fallbackTitle: "中心主题" })
  const parent = findNode(again.root, "分支 A")!
  assert.deepEqual(allChildren(parent).map((n) => n.text), ["子主题", "子主题的兄弟"])
})

test("pathOf / walkAll 与树一致", () => {
  const doc = parseMarkdown(CANONICAL, { fallbackTitle: "中心主题" })
  let count = 0
  walkAll(doc.root, () => count++)
  assert.equal(count, 7)
  const listItem = findNode(doc.root, "列表项一")!
  // 根 → 分支 A(0) → 子主题(0) → 列表项一(0)
  assert.equal(pathOf(listItem), "0/0/0")
})

test("没有 H1 时用文件名作为根", () => {
  const md = ["## 甲", "", "- 乙", ""].join("\n")
  const doc: MindDoc = parseMarkdown(md, { fallbackTitle: "文件名" })
  assert.equal(doc.root.text, "文件名")
  assert.equal(doc.rootFromHeading, false)
  assert.equal(doc.root.children.length, 1)
  assert.equal(doc.root.children[0].text, "甲")
})

test("默认样式可被 frontmatter 覆盖", () => {
  const md = ["---", "mindmap-indent: 2", "---", "", "# 根", "", "## 子", ""].join("\n")
  const doc = parseMarkdown(md, { fallbackTitle: "根" })
  assert.ok(doc.style)
  // 只验证样式对象存在且序列化不丢 frontmatter；具体键由 upstream 定义
  assert.equal(serializeMarkdown(doc), md)
  assert.equal(DEFAULT_STYLE.maxHeadingLevel, 3)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
