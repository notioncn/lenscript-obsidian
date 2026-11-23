/**
 * 锚点索引与失效重定位
 *
 * 主锚：Obsidian 原生块 ID（^id）
 * 兜底链：heading 路径 → 文本指纹相似度 → 行号偏移
 *
 * 纯函数，不依赖 Obsidian API。
 */

import {
  normalizeText,
  similarity,
  splitBlocks,
  type BlockKind,
  type DocBlock,
} from "./blocks"

export interface AnchorIndex {
  blocks: DocBlock[]
  byId: Map<string, DocBlock>
  duplicateBlockIds: string[]
}

export type AnchorStatus = "ok" | "moved" | "broken"
export type AnchorMatch = "id" | "fingerprint" | "heading" | "offset"

export interface AnchorQuery {
  blockId?: string
  headingPath?: string[]
  fingerprint?: string
  /** 失效前的起始行，用于同分候选的偏移优先 */
  offsetHint?: number
  /** 期望的块类型，仅作辅助，不强制过滤 */
  kindHint?: BlockKind
}

export interface AnchorResolution {
  status: AnchorStatus
  /** 0..1 */
  confidence: number
  reason: string
  match?: AnchorMatch
  block?: DocBlock
  /** 块 ID 命中但正文已变 */
  contentChanged?: boolean
  /** 重定位到的块若自身有 ID，给出可修复的 ID */
  suggestedId?: string
}

export function indexAnchors(markdown: string): AnchorIndex {
  const blocks = splitBlocks(markdown)
  const byId = new Map<string, DocBlock>()
  const duplicates = new Set<string>()

  for (const block of blocks) {
    if (!block.blockId) continue
    if (byId.has(block.blockId)) {
      duplicates.add(block.blockId)
      continue
    }
    byId.set(block.blockId, block)
  }

  return { blocks, byId, duplicateBlockIds: [...duplicates] }
}

function samePath(a?: string[], b?: string[]): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (normalizeText(a[i]) !== normalizeText(b[i])) return false
  }
  return true
}

interface Candidate {
  block: DocBlock
  score: number
  confidence: number
  match: AnchorMatch
  reason: string
}

/**
 * 在索引中寻找与查询最匹配的块。
 * 只有证据足够（相似度/路径）时才返回候选。
 */
function findCandidate(
  index: AnchorIndex,
  query: AnchorQuery,
): Candidate | null {
  const queryFp = query.fingerprint ? normalizeText(query.fingerprint) : ""
  let best: Candidate | null = null

  for (const block of index.blocks) {
    if (block.kind === "frontmatter" || block.kind === "code") continue

    const pathMatched = samePath(query.headingPath, block.headingPath)
    const sim = queryFp ? similarity(queryFp, block.fingerprint) : -1

    let candidate: Candidate | null = null

    if (queryFp && sim >= 0.995) {
      // 文本几乎一致：跨 heading 也能找回
      candidate = {
        block,
        score: pathMatched ? 1000 : 900,
        confidence: pathMatched ? 0.9 : 0.8,
        match: "fingerprint",
        reason: pathMatched
          ? "文本指纹完全匹配，且 heading 路径一致"
          : "文本指纹完全匹配，但 heading 路径已变化",
      }
    } else if (pathMatched && queryFp && sim >= 0.55) {
      candidate = {
        block,
        score: 500 + sim * 100,
        confidence: 0.5 + sim * 0.25,
        match: "heading",
        reason: "块 ID 失效，按 heading 路径 + 文本相似度重定位",
      }
    } else if (queryFp && sim >= 0.8) {
      candidate = {
        block,
        score: 300 + sim * 100,
        confidence: 0.6 + sim * 0.1,
        match: "fingerprint",
        reason: "块 ID 失效，按文本指纹重定位",
      }
    } else if (!queryFp && pathMatched && block.kind === "heading") {
      // 只有 heading 路径、没有文本指纹时，仅接受唯一 heading 命中
      candidate = {
        block,
        score: 200,
        confidence: 0.6,
        match: "heading",
        reason: "按 heading 路径命中标题块",
      }
    }

    if (!candidate) continue

    // 同分时优先靠近原行号
    if (query.offsetHint !== undefined) {
      const distance = Math.abs(block.startLine - query.offsetHint)
      candidate.score -= Math.min(distance, 100) * 0.5
    }

    if (!best || candidate.score > best.score) {
      best = candidate
    }
  }

  return best
}

export function resolveAnchor(
  index: AnchorIndex,
  query: AnchorQuery,
): AnchorResolution {
  if (query.blockId) {
    const block = index.byId.get(query.blockId)
    if (block) {
      const contentChanged = query.fingerprint
        ? similarity(query.fingerprint, block.fingerprint) < 0.995
        : false
      return {
        status: "ok",
        confidence: 1,
        match: "id",
        block,
        contentChanged,
        suggestedId: block.blockId,
        reason: contentChanged
          ? "块 ID 命中，但正文内容已修改"
          : "块 ID 命中",
      }
    }
  }

  const candidate = findCandidate(index, query)

  if (!candidate || candidate.confidence < 0.5) {
    return {
      status: "broken",
      confidence: candidate ? candidate.confidence : 0,
      reason: query.blockId
        ? `块 ID ${query.blockId} 已失效，且未找到可信的替代位置`
        : "缺少块 ID，且未找到可信的匹配位置",
    }
  }

  return {
    status: "moved",
    confidence: candidate.confidence,
    match: candidate.match,
    block: candidate.block,
    suggestedId: candidate.block.blockId,
    reason: candidate.reason,
  }
}

/** 供 UI/调试使用的简短锚点描述 */
export function describeAnchor(resolution: AnchorResolution): string {
  switch (resolution.status) {
    case "ok":
      return resolution.contentChanged ? "有效（内容已改）" : "有效"
    case "moved":
      return `已移动（置信度 ${Math.round(resolution.confidence * 100)}%）`
    case "broken":
      return "断链"
  }
}
