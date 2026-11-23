/**
 * NodeRef — 跨文档节点引用
 *
 * 导图节点、画布节点、摘录节点都只存一份轻量引用，
 * 通过块 ID 指回 Markdown 原文，不复制正文。
 */

import { indexAnchors, resolveAnchor, type AnchorIndex } from "./anchor"
import type { BlockKind, DocBlock } from "./blocks"

export interface NodeRefRange {
  startLine: number
  endLine: number
}

export interface NodeRef {
  /** 目标文件路径（vault 相对路径，含 .md） */
  file: string
  /** 主锚：Obsidian 块 ID */
  blockId?: string
  /** 兜底：heading 路径 */
  headingPath?: string[]
  /** 兜底：文本指纹 */
  fingerprint?: string
  /** 兜底：原起始行 */
  offsetHint?: number
  /** 最近一次解析到的行范围 */
  range?: NodeRefRange
  /** 展示用短标签 */
  label?: string
  /** 块类型提示 */
  kind?: BlockKind
}

export type RefStatus = "ok" | "moved" | "broken"

export interface RefResolution {
  status: RefStatus
  confidence: number
  reason: string
  ref: NodeRef
  /** 当前解析到的块 */
  block?: DocBlock
  /** 正文是否已修改（块 ID 仍有效时） */
  contentChanged: boolean
  /** 可写回的修复结果；无需修复时为 null */
  repaired: NodeRef | null
}

/** 从一个已解析的块创建引用 */
export function createNodeRef(
  file: string,
  block: DocBlock,
  label?: string,
): NodeRef {
  return {
    file,
    blockId: block.blockId,
    headingPath: block.headingPath.slice(),
    fingerprint: block.fingerprint,
    offsetHint: block.startLine,
    range: { startLine: block.startLine, endLine: block.endLine },
    label: label ?? (block.text.slice(0, 60) || undefined),
    kind: block.kind,
  }
}

function sameRefValue(a: NodeRef, b: NodeRef): boolean {
  return (
    a.blockId === b.blockId &&
    a.fingerprint === b.fingerprint &&
    a.offsetHint === b.offsetHint &&
    (a.headingPath ?? []).join("\u0001") ===
      (b.headingPath ?? []).join("\u0001") &&
    a.range?.startLine === b.range?.startLine &&
    a.range?.endLine === b.range?.endLine &&
    a.kind === b.kind
  )
}

function buildRepairedRef(
  ref: NodeRef,
  block: DocBlock,
): NodeRef | null {
  // 块 ID 被删但被指纹找回时，沿用旧 ID（调用方可把旧 ID 重新注入目标块）
  const blockId = block.blockId ?? ref.blockId
  if (!blockId) return null
  const next: NodeRef = {
    ...ref,
    blockId,
    headingPath: block.headingPath.slice(),
    fingerprint: block.fingerprint,
    offsetHint: block.startLine,
    range: { startLine: block.startLine, endLine: block.endLine },
    kind: block.kind,
  }
  return sameRefValue(ref, next) ? null : next
}

/**
 * 解析引用。传入 index 可复用同一文档的锚点索引。
 */
export function resolveNodeRef(
  markdown: string,
  ref: NodeRef,
  index?: AnchorIndex,
): RefResolution {
  const idx = index ?? indexAnchors(markdown)
  const resolution = resolveAnchor(idx, {
    blockId: ref.blockId,
    headingPath: ref.headingPath,
    fingerprint: ref.fingerprint,
    offsetHint: ref.offsetHint,
    kindHint: ref.kind,
  })

  const block = resolution.block
  const repaired = block ? buildRepairedRef(ref, block) : null

  return {
    status: resolution.status,
    confidence: resolution.confidence,
    reason: resolution.reason,
    ref,
    block,
    contentChanged: !!resolution.contentChanged,
    repaired,
  }
}

/** 批量解析同一文档中的多条引用 */
export function resolveNodeRefs(
  markdown: string,
  refs: NodeRef[],
): RefResolution[] {
  const index = indexAnchors(markdown)
  return refs.map((ref) => resolveNodeRef(markdown, ref, index))
}

/** 把修复结果写回引用对象（就地修改并返回是否发生变化） */
export function applyRepair(
  ref: NodeRef,
  resolution: RefResolution,
): boolean {
  if (!resolution.repaired) return false
  ref.blockId = resolution.repaired.blockId
  ref.headingPath = resolution.repaired.headingPath
  ref.fingerprint = resolution.repaired.fingerprint
  ref.offsetHint = resolution.repaired.offsetHint
  ref.range = resolution.repaired.range
  ref.kind = resolution.repaired.kind
  return true
}
