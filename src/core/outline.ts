/**
 * 统一大纲/导图节点模型 — 同源双视图的纯函数核心
 *
 * Obsidian Markdown → DocBlock（blocks.ts）→ OutlineNode 树
 *   ↓
 *   ├─ OutlineView 侧栏（可折叠/拖拽调层级/点击跳转）
 *   └─ MindmapView 导图（同一份节点，正交布局，位置持久化到 .lens.json）
 *
 * Markdown 是源文件，.lens.json 只存 UI 状态（位置/折叠/自定义节点）。
 * 拖拽调层级只改 heading 深度 / 段落缩进，不丢块 ID，anchor 重定位链保持有效。
 */

import {
  findBlockAtLine,
  splitBlocks,
  type BlockKind,
  type DocBlock,
} from "./blocks"
import type { ScriptMarkerType } from "../script-types"

// =========================================================================
// OutlineNode
// =========================================================================

export interface SavedNode {
  id: string
  collapsed?: boolean
  x?: number
  y?: number
  /** 不是从 Markdown 来的自定义节点；可自由编辑 */
  custom?: boolean
  customText?: string
  /** 任意侧边数据（画布位置/颜色/分组等） */
  meta?: Record<string, unknown>
}

export interface OutlineNode {
  /** 稳定树内 ID：优先块 ID；否则 heading 块用 "h:<level>:<line>"，其它用 "b:<index>" */
  id: string
  /** 展示标签：HeadingText / marker+正文前 60 字 / 正文前 60 字 */
  label: string
  /** 对应 DocBlock 下标；-1 = 侧栏自定义节点（无 Markdown 源） */
  blockIndex: number
  kind: BlockKind
  /** heading 深度 (1-6) 或 marker 块的逻辑深度 */
  level: number
  marker?: ScriptMarkerType
  /** 命中标签的文字/颜色（官方与自定义标签都有） */
  tagLabel?: string
  tagColor?: string
  tagMarker?: string
  /** 原文行范围（0-based，含） */
  startLine: number
  endLine: number
  /** 原文正文（不含 marker 前缀与块 ID） */
  text: string
  parentId?: string
  children: OutlineNode[]
  collapsed: boolean
  /** 导图布局坐标（侧栏持久化） */
  x?: number
  y?: number
  /** 运行时可填；避免污染持久化 JSON */
  depth?: number
}

// =========================================================================
// 构建
// =========================================================================

function makeId(block: DocBlock): string {
  if (block.blockId) return block.blockId
  if (block.kind === "heading") {
    return `h:${block.level ?? 1}:${block.startLine}`
  }
  return `b:${block.index}`
}

export function buildTree(markdown: string): OutlineNode[] {
  const blocks = splitBlocks(markdown)
  const roots: OutlineNode[] = []
  const headingStack: OutlineNode[] = []

  for (const block of blocks) {
    if (block.kind === "frontmatter") continue
    if (block.kind === "code") continue
    if (block.kind === "table") continue

    const parent = headingStack[headingStack.length - 1]
    const level = block.kind === "heading" ? block.level ?? 1 : (parent?.level ?? 0) + 1

    const label =
      block.kind === "heading"
        ? block.text || `(标题 ${level})`
        : block.tag
          ? `${block.tag.label} ${block.text}`.trim()
          : block.markerRaw
            ? `${block.markerRaw} ${block.text}`.trim()
            : block.text

    const node: OutlineNode = {
      id: makeId(block),
      label,
      blockIndex: block.index,
      kind: block.kind,
      level,
      marker: block.marker,
      tagLabel: block.tag?.label,
      tagColor: block.tag?.color,
      tagMarker: block.tag?.marker,
      startLine: block.startLine,
      endLine: block.endLine,
      text: block.text,
      children: [],
      collapsed: false,
    }

    if (block.kind === "heading") {
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1].level ?? 0) >= level
      ) {
        headingStack.pop()
      }
      if (headingStack.length === 0) {
        roots.push(node)
      } else {
        const top = headingStack[headingStack.length - 1]
        top.children.push(node)
        node.parentId = top.id
      }
      headingStack.push(node)
    } else if (parent) {
      parent.children.push(node)
      node.parentId = parent.id
    } else {
      roots.push(node)
    }
  }

  return roots
}

/** 给树里的每个节点计算 depth（根=0） */
export function computeDepth(roots: OutlineNode[]): void {
  const walk = (nodes: OutlineNode[], d: number) => {
    for (const n of nodes) {
      n.depth = d
      walk(n.children, d + 1)
    }
  }
  walk(roots, 0)
}

/** 展平所有节点（按文档顺序） */
export function flatten(roots: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (!n.collapsed) walk(n.children)
    }
  }
  walk(roots)
  return out
}

export function flattenAll(roots: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(roots)
  return out
}

/** 展平为按文档行序的线性数组（不考虑 collapsed） */
export function flattenByLine(roots: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = flattenAll(roots)
  out.sort((a, b) => a.startLine - b.startLine)
  return out
}

// =========================================================================
// 节点操作
// =========================================================================

export type ReparentResult = { ok: true; tree: OutlineNode[] } | { ok: false; reason: string }

/** 把 node 从当前 parent 的 children 中移除；需传入 roots 以便定位原 parent */
function detach(node: OutlineNode, roots: OutlineNode[]): void {
  if (!node.parentId) return
  const parent = findById(roots, node.parentId)
  if (!parent) return
  const idx = parent.children.findIndex((c) => c.id === node.id)
  if (idx >= 0) parent.children.splice(idx, 1)
}

export function findById(roots: OutlineNode[] | undefined, id: string): OutlineNode | undefined {
  const stack = roots ? [...roots] : []
  while (stack.length) {
    const cur = stack.pop()!
    if (cur.id === id) return cur
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i])
    }
  }
  return undefined
}

/** 判断 candidate 是否是 ancestorOf 的后代 */
export function isAncestor(
  roots: OutlineNode[],
  ancestorId: string,
  descendantId: string,
): boolean {
  const ancestor = findById(roots, ancestorId)
  if (!ancestor) return false
  const descendant = findById(ancestor.children, descendantId)
  return !!descendant
}

/** 把 node 重挂到 newParent 下；可选 siblingAt = 在哪个已有 sibling 之前插入 */
export function reparent(
  roots: OutlineNode[],
  nodeId: string,
  newParentId: string,
  siblingAt?: string,
): ReparentResult {
  const node = findById(roots, nodeId)
  if (!node) return { ok: false, reason: `未找到节点 ${nodeId}` }

  if (node.parentId === newParentId && !siblingAt) {
    return { ok: true, tree: roots }
  }

  if (newParentId !== node.id && isAncestor(roots, nodeId, newParentId)) {
    return { ok: false, reason: "不能把节点挂到自己的后代下面" }
  }

  const newParent = newParentId === "root"
    ? { id: "root", children: roots, parentId: undefined } as OutlineNode
    : findById(roots, newParentId)

  if (!newParent) return { ok: false, reason: `未找到新父节点 ${newParentId}` }

  // 先 detach
  if (node.parentId) detach(node, roots)
  else {
    const idx = roots.findIndex((r) => r.id === node.id)
    if (idx >= 0) roots.splice(idx, 1)
  }

  let insertAt = newParent.children.length
  if (siblingAt) {
    const sIdx = newParent.children.findIndex((c) => c.id === siblingAt)
    if (sIdx >= 0) insertAt = sIdx
  }

  newParent.children.splice(insertAt, 0, node)
  node.parentId = newParent.id === "root" ? undefined : newParent.id

  // 更新 level（heading 深度保持自己的相对差；marker/普通块深度 = 父深度 + 1）
  fixLevels(node, newParent.id === "root" ? 0 : (newParent.level ?? 0))
  computeDepth(roots)

  return { ok: true, tree: roots }
}

function fixLevels(node: OutlineNode, parentLevel: number): void {
  // heading 块的 level = 父 heading 深度 + heading 自身层级差
  // 非 heading 块的 level = parentLevel + 1
  if (node.kind === "heading") {
    // 保持 heading 的相对深度；但如果父非 heading，则用父 heading 深度 + 自身层级
    // 简化：heading level = 自己原来的 heading level（由原文定），但不能小于父 heading level
    // 更简化：保留 heading level 原值
  } else {
    node.level = parentLevel + 1
  }
  for (const c of node.children) {
    fixLevels(c, node.kind === "heading" ? node.level : node.level)
  }
}

/** 在 parent 下新增一个 marker/段落节点（纯 UI 侧新增，无 Markdown 源） */
export function addChildNode(
  roots: OutlineNode[],
  parentId: string | "root",
  kind: BlockKind,
  label: string,
  marker?: ScriptMarkerType,
): OutlineNode | null {
  const parent = parentId === "root"
    ? { id: "root", children: roots, parentId: undefined } as OutlineNode
    : findById(roots, parentId)

  if (!parent) return null

  const blockIndex = -1
  const node: OutlineNode = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    blockIndex,
    kind,
    level: (parent.level ?? 0) + 1,
    marker,
    startLine: -1,
    endLine: -1,
    text: label,
    children: [],
    collapsed: false,
  }

  parent.children.push(node)
  node.parentId = parent.id === "root" ? undefined : parent.id
  computeDepth(roots)
  return node
}

/** 删除节点：整棵子树移除 */
export function removeNode(
  roots: OutlineNode[],
  nodeId: string,
): OutlineNode[] {
  const node = findById(roots, nodeId)
  if (!node) return roots
  if (node.parentId) detach(node, roots)
  else {
    const idx = roots.findIndex((r) => r.id === nodeId)
    if (idx >= 0) roots.splice(idx, 1)
  }
  return roots
}

// =========================================================================
// Markdown 反写
// =========================================================================

interface SerializeCtx {
  lines: string[]
  blocks: DocBlock[]
  /** 新的块 ID 映射：旧 ID → 新 ID（当旧 ID 冲突时生成新的） */
  idRewrites: Map<string, string>
  nextLine: number
  /** 下一个 heading 深度 */
  nextHeadingDepth: number
  /** 下一个非 heading 缩进（基于父 heading level） */
  nonHeadingDepth: number
}

function escapeForId(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 24)
}

/**
 * 把 OutlineNode 树序列化为 Markdown 文本。
 * heading 块按 depth 输出 `# *depth* 标题`；
 * marker 块输出 marker 原文 + 正文；
 * 普通段落输出原文；
 * 每块末尾补 `^id`（沿用原块 ID；自定义块生成新 ID）。
 */
export function serializeTree(
  roots: OutlineNode[],
  originalMarkdown?: string,
): string {
  const blocks = originalMarkdown ? splitBlocks(originalMarkdown) : []
  const ctx: SerializeCtx = {
    lines: [],
    blocks,
    idRewrites: new Map(),
    nextLine: 0,
    nextHeadingDepth: 0,
    nonHeadingDepth: 0,
  }

  const walk = (node: OutlineNode) => {
    const headingDepth = node.kind === "heading" ? node.level : ctx.nonHeadingDepth + 1

    if (node.kind === "heading") {
      ctx.nextHeadingDepth = headingDepth
      ctx.nonHeadingDepth = headingDepth
    }

    const block = node.blockIndex >= 0 ? blocks[node.blockIndex] : undefined

    let line = ""
    if (node.kind === "heading") {
      line = `${"#".repeat(headingDepth)} ${node.text || ""}`
    } else if (block) {
      // 有原块的：尽量保留原文（marker 缩进等），只做深度调整
      line = reconstructBlockLine(node, block, headingDepth)
    } else {
      // 自定义节点
      line = node.label
    }

    let usedId = node.id
    // 自定义节点没有真的块 ID
    if (node.blockIndex < 0) {
      usedId = `ls-${escapeForId(node.label || "custom")}-${Math.floor(Math.random() * 1000)}`
    }

    line = `${line} ^${usedId}`
    ctx.lines.push(line)

    for (const child of node.children) {
      walk(child)
    }

    // 块间空行
    ctx.lines.push("")

    if (node.kind === "heading") {
      ctx.nonHeadingDepth = headingDepth
    }
  }

  for (const root of roots) walk(root)

  // 去掉末尾的多余空行
  while (ctx.lines.length && ctx.lines[ctx.lines.length - 1] === "") {
    ctx.lines.pop()
  }

  return ctx.lines.join("\n")
}

function reconstructBlockLine(
  node: OutlineNode,
  block: DocBlock,
  headingDepth: number,
): string {
  if (block.markerRaw) {
    return `${block.markerRaw} ${node.text}`
  }
  // 列表项 / 引用 / 表格等复杂块先降级处理（第一版不重排列表层级）
  return node.text || block.text
}

// =========================================================================
// 侧栏布局合并
// =========================================================================

/** 把 SavedNode[]（.lens.json 存的位置/折叠/自定义节点）合并进树 */
export function mergeLayout(
  roots: OutlineNode[],
  saved: SavedNode[],
): { tree: OutlineNode[]; extras: OutlineNode[] } {
  const savedMap = new Map(saved.map((s) => [s.id, s]))
  const extras: OutlineNode[] = []

  const walk = (nodes: OutlineNode[]): OutlineNode[] => {
    for (const n of nodes) {
      const s = savedMap.get(n.id)
      if (s) {
        if (s.collapsed !== undefined) n.collapsed = s.collapsed
        if (s.x !== undefined) n.x = s.x
        if (s.y !== undefined) n.y = s.y
      }
      walk(n.children)
    }
    return nodes
  }

  walk(roots)

  // saved 里有、树里没有的 → 自定义节点 / 已消失节点 → extras
  const treeIds = new Set<string>()
  const walkIds = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      treeIds.add(n.id)
      walkIds(n.children)
    }
  }
  walkIds(roots)

  for (const s of saved) {
    if (!treeIds.has(s.id)) {
      extras.push({
        id: s.id,
        label: s.customText ?? "(已消失节点)",
        blockIndex: -1,
        kind: "paragraph",
        level: s.meta?.level as number ?? 0,
        startLine: -1,
        endLine: -1,
        text: s.customText ?? "",
        children: [],
        collapsed: s.collapsed ?? false,
        x: s.x,
        y: s.y,
      })
    }
  }

  return { tree: roots, extras }
}

/** 把树（含 extras）序列化为 SavedNode[] 存 .lens.json */
export function serializeLayout(
  roots: OutlineNode[],
  extras: OutlineNode[] = [],
): SavedNode[] {
  const out: SavedNode[] = []
  const walk = (nodes: OutlineNode[], custom = false) => {
    for (const n of nodes) {
      const s: SavedNode = {
        id: n.id,
      }
      if (n.collapsed) s.collapsed = true
      if (n.x !== undefined) s.x = n.x
      if (n.y !== undefined) s.y = n.y
      if (custom || n.blockIndex < 0) {
        s.custom = true
        s.customText = n.text || n.label
      }
      out.push(s)
      walk(n.children, custom)
    }
  }
  walk(roots)
  walk(extras, true)
  return out
}

// =========================================================================
// Mindmap 正交布局（纯函数，不依赖 DOM）
// =========================================================================

export interface LayoutNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  parentId?: string
  childrenIds: string[]
  label: string
}

export interface MindmapLayout {
  nodes: Map<string, LayoutNode>
  width: number
  height: number
}

const NODE_W = 220
const NODE_H = 42
const V_GAP = 18
const H_GAP = 120

/** 左→右正交布局，根节点居中左 */
export function layoutMindmap(roots: OutlineNode[]): MindmapLayout {
  const nodes = new Map<string, LayoutNode>()
  let maxY = 0

  const walk = (node: OutlineNode, x: number): number => {
    const childYs: number[] = []
    let totalH = 0

    const children = node.children.filter((c) => !c.collapsed)
    for (const c of children) {
      const y = walk(c, x + NODE_W + H_GAP)
      childYs.push(y)
      if (childYs.length > 1) totalH += y - childYs[childYs.length - 2]
    }

    const y = childYs.length
      ? (Math.min(...childYs) + Math.max(...childYs)) / 2
      : Math.max(0, maxY)

    nodes.set(node.id, {
      id: node.id,
      x,
      y: y - NODE_H / 2,
      w: NODE_W,
      h: NODE_H,
      parentId: node.parentId,
      childrenIds: children.map((c) => c.id),
      label: node.label,
    })

    maxY = Math.max(maxY, y + NODE_H / 2 + V_GAP)
    return y
  }

  for (const root of roots) walk(root, 0)

  let maxX = 0
  for (const n of nodes.values()) maxX = Math.max(maxX, n.x + n.w)

  return {
    nodes,
    width: maxX + 40,
    height: maxY + 40,
  }
}

export { findBlockAtLine }
