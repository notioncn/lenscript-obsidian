/**
 * M2 Outline 树与 Mindmap 布局单测
 */

import assert from "node:assert/strict"
import {
  addChildNode,
  buildTree,
  computeDepth,
  findById,
  flattenAll,
  flattenByLine,
  isAncestor,
  layoutMindmap,
  mergeLayout,
  reparent,
  removeNode,
  serializeLayout,
  serializeTree,
} from "../src/core/outline"

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
  "",
  "# 项目名 ^p-1",
  "/s 场景一",
  "/a 动作描述",
  "",
  "## 子标题 ^h-1",
  "#d 描述内容",
  "- 列表项一 ^l-1",
  "- 列表项二",
  "",
  "> 引用段落",
  "",
  "正文段落",
].join("\n")

console.log("outline.ts")

test("buildTree：heading 建栈，marker 强制独立块", () => {
  const roots = buildTree(SAMPLE)
  assert.equal(roots.length, 1, "一个根 heading")
  const project = roots[0]
  assert.equal(project.label, "项目名")
  // /s、/a、## 子标题 三个直接子节点
  assert.equal(project.children.length, 3)
  assert.equal(project.children[0].marker, "s")
  assert.equal(project.children[0].text, "场景一")
  assert.equal(project.children[1].marker, "a")
  assert.equal(project.children[1].text, "动作描述")
  assert.equal(project.children[2].label, "子标题")
  // 子标题下：#d + 列表项一 + 列表项二 + 引用段落 + 正文段落
  assert.equal(project.children[2].children.length, 5)
})

test("computeDepth / flatten / flattenByLine", () => {
  const roots = buildTree(SAMPLE)
  computeDepth(roots)
  const all = flattenAll(roots)
  assert.equal(all.length, 9)
  assert.equal(roots[0].depth, 0)
  assert.equal(roots[0].children[0].depth, 1)
  const byLine = flattenByLine(roots)
  for (let i = 1; i < byLine.length; i++) {
    assert.ok(
      byLine[i].startLine >= byLine[i - 1].startLine,
      "按文档行序排列",
    )
  }
})

test("reparent：marker 块挂到另一个 heading 下", () => {
  const roots = buildTree(SAMPLE)
  const scene1Id = roots[0].children[0].id   // /s 场景一
  const subTitleId = roots[0].children[2].id // ## 子标题

  const result = reparent(roots, scene1Id, subTitleId)
  assert.equal(result.ok, true)
  const sub = findById(roots, subTitleId)!
  const scene = findById(roots, scene1Id)!
  assert.equal(scene.parentId, subTitleId)
  assert.equal(sub.children[sub.children.length - 1].id, scene1Id)
  assert.equal(scene.level, sub.level + 1)
})

test("reparent：heading 不能挂到自己后代下", () => {
  const roots = buildTree(SAMPLE)
  const subId = roots[0].children[2].id
  const descId = roots[0].children[2].children[0].id
  const result = reparent(roots, subId, descId)
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes("后代"))
})

test("reparent：挂到 root 下", () => {
  const roots = buildTree(SAMPLE)
  const sceneId = roots[0].children[0].id
  const result = reparent(roots, sceneId, "root")
  assert.equal(result.ok, true)
  assert.equal(result.tree.length, 2)
  assert.equal(result.tree[1].id, sceneId)
  assert.equal(result.tree[1].parentId, undefined)
})

test("isAncestor 正确识别", () => {
  const roots = buildTree(SAMPLE)
  const rootId = roots[0].id
  const subId = roots[0].children[2].id
  const descId = roots[0].children[2].children[0].id
  assert.ok(isAncestor(roots, subId, descId))
  assert.equal(isAncestor(roots, descId, subId), false)
  assert.equal(isAncestor(roots, rootId, rootId), false)
})

test("addChildNode 自定义节点", () => {
  const roots = buildTree(SAMPLE)
  const node = addChildNode(roots, roots[0].id, "paragraph", "临时想法")
  assert.ok(node)
  assert.equal(node.blockIndex, -1)
  assert.equal(node.label, "临时想法")
  assert.equal(node.parentId, roots[0].id)
})

test("removeNode", () => {
  const roots = buildTree(SAMPLE)
  const before = flattenAll(roots).length
  const targetId = roots[0].children[0].id
  removeNode(roots, targetId)
  assert.equal(flattenAll(roots).length, before - 1)
  assert.equal(findById(roots, targetId), undefined)
  assert.equal(roots[0].children.length, 2)
})

test("mergeLayout 合并折叠/位置，未匹配节点进 extras", () => {
  const roots = buildTree(SAMPLE)
  const sceneId = roots[0].children[0].id
  mergeLayout(roots, [
    { id: sceneId, collapsed: true, x: 100, y: 200 },
    { id: "ghost-node", custom: true, customText: "已消失的想法" },
  ])
  const scene = findById(roots, sceneId)!
  assert.equal(scene.collapsed, true)
  assert.equal(scene.x, 100)
  assert.equal(scene.y, 200)

  const { extras } = mergeLayout(roots, [
    { id: sceneId },
    { id: "ghost-node", custom: true, customText: "已消失的想法" },
  ])
  assert.equal(extras.length, 1)
  assert.equal(extras[0].id, "ghost-node")
})

test("serializeLayout 可 roundtrip", () => {
  const roots = buildTree(SAMPLE)
  const sceneId = roots[0].children[0].id
  mergeLayout(roots, [{ id: sceneId, collapsed: true, x: 1, y: 2 }])
  const saved = serializeLayout(roots)
  assert.ok(saved.some((s) => s.id === sceneId && s.collapsed && s.x === 1))
  // roundtrip
  const fresh = buildTree(SAMPLE)
  const { tree } = mergeLayout(fresh, saved)
  const scene = findById(tree, sceneId)!
  assert.equal(scene.collapsed, true)
  assert.equal(scene.x, 1)
})

test("serializeTree roundtrip：所有节点都在（不关心文本细节）", () => {
  const roots = buildTree(SAMPLE)
  const md = serializeTree(roots, SAMPLE)
  const roots2 = buildTree(md)
  const before = flattenAll(roots).length
  const after = flattenAll(roots2).length
  assert.equal(before, after)
})

test("layoutMindmap：根在 x=0，所有节点都有坐标", () => {
  const roots = buildTree(SAMPLE)
  const layout = layoutMindmap(roots)
  assert.ok(layout.width > 0)
  assert.ok(layout.height > 0)
  const all = flattenAll(roots)
  for (const n of all) {
    const ln = layout.nodes.get(n.id)
    assert.ok(ln, `节点 ${n.id} 没有布局`)
    assert.ok(ln.w > 0 && ln.h > 0)
  }
  const rootLayout = layout.nodes.get(roots[0].id)!
  assert.equal(rootLayout.x, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
