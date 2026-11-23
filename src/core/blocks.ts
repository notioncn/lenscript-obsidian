/**
 * 块切分 — 锚点系统的纯函数核心
 *
 * 把 Markdown 文本切成可锚定的块（heading / 段落 / 列表项 / 引用 / 表格），
 * 识别并剥离 Obsidian 原生块 ID（^id），为每块生成文本指纹与 heading 路径。
 *
 * 本文件不依赖 Obsidian API，可直接在 Node 下做单元测试。
 */

import {
  isModevolType,
  isScriptType,
  type ScriptMarkerType,
} from "../script-types"
import { getActiveTags, matchTagAtLine } from "./tags"

export interface BlockTag {
  id: string
  marker: string
  label: string
  color: string
  group: "semantic" | "script" | "custom"
}

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "table"
  | "code"
  | "frontmatter"

export interface DocBlock {
  /** 文档内顺序下标（从 0 开始） */
  index: number
  kind: BlockKind
  /** 0-based，含 */
  startLine: number
  /** 0-based，含（已剥离独立块 ID 行） */
  endLine: number
  /** heading 层级 1-6 */
  level?: number
  /** 当前块所处的 heading 路径；heading 块自身路径包含自己 */
  headingPath: string[]
  /** 段首语义标记（#d / #s 等），自定义标签这里为 undefined */
  marker?: ScriptMarkerType
  /** 标记原文，例如 "#d" / "#s" / "#o" */
  markerRaw?: string
  /** 命中标签的完整信息（含自定义标签的文字与颜色） */
  tag?: BlockTag
  /** 去掉块 ID 与段首标记后的正文 */
  text: string
  /** 归一化文本，用于失效重定位 */
  fingerprint: string
  /** Obsidian 原生块 ID（^id 中的 id） */
  blockId?: string
  /** 去掉块 ID 后的块原文 */
  raw: string
}

export interface RawBlock {
  kind: BlockKind
  startLine: number
  endLine: number
  level?: number
  /** 独立成行的块 ID 所在行（^id） */
  idLine?: number
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+/
const QUOTE_RE = /^[ \t]*>[ \t]?/
const TABLE_RE = /^[ \t]*\|/
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/
const STANDALONE_ID_RE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/
const TRAILING_ID_RE = /[ \t]+\^([A-Za-z0-9-]+)[ \t]*$/

/** 可注入块 ID 的块类型 */
export const INJECTABLE_KINDS: ReadonlySet<BlockKind> = new Set([
  "heading",
  "paragraph",
  "list",
  "quote",
  "table",
])

/** 文本归一化：去掉 Markdown 符号与标点，压缩空白，转小写 */
export function normalizeText(text: string): string {
  return text
    .replace(/[`*_~#>]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** 字符二元组 Dice 相似度，0..1 */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0

  const grams = new Map<string, number>()
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }

  let overlap = 0
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2)
    const n = grams.get(g)
    if (n) {
      overlap++
      grams.set(g, n - 1)
    }
  }

  return (2 * overlap) / (x.length - 1 + y.length - 1)
}

/** 32 位 FNV-1a → base36 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6)
}

/**
 * 生成一个不与 used 冲突的块 ID。
 * Obsidian 块 ID 只允许字母、数字、连字符。
 */
export function generateBlockId(
  seed: string,
  used: ReadonlySet<string> = new Set(),
  prefix = "ls",
): string {
  const base = `${prefix}-${hashText(seed)}`
  let id = base
  let n = 2
  while (used.has(id)) {
    id = `${base}-${n++}`
  }
  return id
}

/** 找到包含指定行的块（用于“复制当前块引用”） */
export function findBlockAtLine(
  blocks: DocBlock[],
  line: number,
): DocBlock | undefined {
  return blocks.find((b) => line >= b.startLine && line <= b.endLine)
}

interface RawScanState {
  raws: RawBlock[]
  cur: RawBlock | null
  last: RawBlock | null
}

function pushOpen(state: RawScanState, block: RawBlock): void {
  state.raws.push(block)
  state.last = block
  state.cur = block
}

function pushClosed(state: RawScanState, block: RawBlock): void {
  state.raws.push(block)
  state.last = block
  state.cur = null
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function isFenceClose(line: string, ch: string, min: number): boolean {
  const t = line.trim()
  if (t.length < min || t[0] !== ch) return false
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ch) return false
  }
  return true
}

/**
 * 把 Markdown 切成原始块（尚未计算指纹/ID/heading 路径）
 */
export function scanRawBlocks(markdown: string): RawBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const state: RawScanState = { raws: [], cur: null, last: null }

  let i = 0

  // YAML / TOML frontmatter：整块跳过，不注入 ID
  const first = lines[0]?.trim()
  if (first === "---" || first === "+++") {
    let close = -1
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === first) {
        close = j
        break
      }
    }
    if (close > 0) {
      pushClosed(state, { kind: "frontmatter", startLine: 0, endLine: close })
      i = close + 1
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 代码围栏：整块保留，不解析内部结构
    const fence = line.match(FENCE_RE)
    if (fence) {
      const ch = fence[1][0]
      const min = fence[1].length
      let j = i + 1
      while (j < lines.length && !isFenceClose(lines[j], ch, min)) j++
      const endLine = j < lines.length ? j : lines.length - 1
      pushClosed(state, { kind: "code", startLine: i, endLine })
      i = endLine
      continue
    }

    if (isBlank(line)) {
      state.cur = null
      continue
    }

    // 独立成行的块 ID，挂到紧邻的上一个块
    const standalone = trimmed.match(STANDALONE_ID_RE)
    if (standalone) {
      const target = state.cur ?? state.last
      const attachable =
        target &&
        target.endLine === i - 1 &&
        target.kind !== "code" &&
        target.kind !== "frontmatter"
      if (attachable) {
        target.endLine = i
        target.idLine = i
        continue
      }
    }

    // heading
    const heading = line.match(HEADING_RE)
    if (heading) {
      pushClosed(state, {
        kind: "heading",
        startLine: i,
        endLine: i,
        level: heading[1].length,
      })
      continue
    }

    // 引用块
    if (QUOTE_RE.test(line)) {
      if (state.cur?.kind === "quote") {
        state.cur.endLine = i
      } else {
        pushOpen(state, { kind: "quote", startLine: i, endLine: i })
      }
      continue
    }

    // 表格
    if (TABLE_RE.test(line)) {
      if (state.cur?.kind === "table") {
        state.cur.endLine = i
      } else {
        pushOpen(state, { kind: "table", startLine: i, endLine: i })
      }
      continue
    }

    // 段首 marker 行强制开启新 paragraph 块（#d / #s 等显式分隔）
    const hasMarker = !!matchTagAtLine(line, getActiveTags())
    if (hasMarker) {
      state.cur = null
      pushOpen(state, { kind: "paragraph", startLine: i, endLine: i })
      continue
    }

    // 列表项（嵌套项视作独立块，便于导图逐项挂锚点）
    if (LIST_RE.test(line)) {
      state.cur = null
      pushOpen(state, { kind: "list", startLine: i, endLine: i })
      continue
    }

    // 列表项的缩进续行
    if (state.cur?.kind === "list" && /^[ \t]+/.test(line)) {
      state.cur.endLine = i
      continue
    }

    // 普通段落
    if (state.cur?.kind === "paragraph") {
      state.cur.endLine = i
      continue
    }

    pushOpen(state, { kind: "paragraph", startLine: i, endLine: i })
  }

  return state.raws
}

function extractText(
  kind: BlockKind,
  contentLines: string[],
): string {
  if (contentLines.length === 0) return ""

  if (kind === "heading") {
    const first = contentLines[0].replace(/^#{1,6}[ \t]+/, "")
    return [first, ...contentLines.slice(1)].join("\n").trim()
  }

  if (kind === "quote") {
    return contentLines
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ""))
      .join("\n")
      .trim()
  }

  if (kind === "list") {
    const first = contentLines[0].replace(LIST_RE, "")
    return [first, ...contentLines.slice(1)].join("\n").trim()
  }

  return contentLines.join("\n").trim()
}

/**
 * 切块并完成 ID / 指纹 / heading 路径计算
 */
export function splitBlocks(markdown: string): DocBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const raws = scanRawBlocks(normalized)
  const blocks: DocBlock[] = []
  const headingStack: Array<{ level: number; text: string }> = []

  for (const raw of raws) {
    let startLine = raw.startLine
    let endLine = raw.endLine
    let blockId: string | undefined

    if (raw.idLine !== undefined) {
      blockId = lines[raw.idLine].trim().slice(1)
      endLine = raw.idLine - 1
      // 只有块 ID、没有正文的块直接丢弃
      if (endLine < startLine) continue
    }

    const contentLines = lines.slice(startLine, endLine + 1)
    const trailing = contentLines[contentLines.length - 1]?.match(TRAILING_ID_RE)
    if (trailing) {
      if (!blockId) blockId = trailing[1]
      contentLines[contentLines.length - 1] = contentLines[
        contentLines.length - 1
      ].replace(TRAILING_ID_RE, "")
    }

    const rawText = extractText(raw.kind, contentLines)
    let text = rawText
    let marker: ScriptMarkerType | undefined
    let markerRaw: string | undefined
    let tag: BlockTag | undefined

    if (
      raw.kind === "heading" ||
      raw.kind === "paragraph" ||
      raw.kind === "list" ||
      raw.kind === "quote"
    ) {
      const matched = matchTagAtLine(text, getActiveTags())
      if (matched) {
        markerRaw = matched.marker
        tag = {
          id: matched.tag.id,
          marker: matched.tag.marker,
          label: matched.tag.label,
          color: matched.tag.color,
          group: matched.tag.group,
        }
        const type = matched.marker.slice(1)
        if (isModevolType(type) || isScriptType(type)) marker = type
        text = text.slice(matched.marker.length).trim()
      }
    }

    if (raw.kind === "heading") {
      const level = raw.level ?? 1
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop()
      }
      headingStack.push({ level, text })
    }

    const headingPath = headingStack.map((h) => h.text)
    const fingerprint = normalizeText(text) || normalizeText(rawText)

    blocks.push({
      index: blocks.length,
      kind: raw.kind,
      startLine,
      endLine,
      level: raw.level,
      headingPath,
      marker,
      markerRaw,
      tag,
      text,
      fingerprint,
      blockId,
      raw: contentLines.join("\n"),
    })
  }

  return blocks
}

export interface InjectedBlockId {
  blockIndex: number
  blockId: string
  kind: BlockKind
  startLine: number
  endLine: number
}

export interface InjectOptions {
  /** 只注入指定下标的块 */
  onlyBlockIndex?: number
  /** 块 ID 前缀，默认 ls */
  prefix?: string
}

export interface InjectResult {
  markdown: string
  injected: InjectedBlockId[]
  blocks: DocBlock[]
}

/**
 * 为缺失块 ID 的块注入 ^id，返回新 Markdown。
 * 幂等：已有 ID 的块不会被重复注入。
 */
export function injectBlockIds(
  markdown: string,
  options: InjectOptions = {},
): InjectResult {
  const blocks = splitBlocks(markdown)
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const used = new Set<string>()
  for (const b of blocks) {
    if (b.blockId) used.add(b.blockId)
  }

  const injected: InjectedBlockId[] = []

  for (const block of blocks) {
    if (!INJECTABLE_KINDS.has(block.kind)) continue
    if (block.blockId) continue
    if (
      options.onlyBlockIndex !== undefined &&
      block.index !== options.onlyBlockIndex
    ) {
      continue
    }

    const id = generateBlockId(
      `${block.kind}:${block.fingerprint}:${block.index}`,
      used,
      options.prefix,
    )
    used.add(id)

    const lineIdx = block.endLine
    const targetLine = lines[lineIdx] ?? ""
    lines[lineIdx] = `${targetLine.replace(/[ \t]+$/, "")} ^${id}`

    injected.push({
      blockIndex: block.index,
      blockId: id,
      kind: block.kind,
      startLine: block.startLine,
      endLine: block.endLine,
    })
  }

  const nextMarkdown = lines.join("\n")
  return {
    markdown: nextMarkdown,
    injected,
    blocks: injected.length > 0 ? splitBlocks(nextMarkdown) : blocks,
  }
}

/**
 * 把指定块 ID 重新挂回某个块（用于引用修复时恢复被删的 ^id）。
 * 块既有的 ID 不会被覆盖。
 */
export function attachBlockId(
  markdown: string,
  blockIndex: number,
  blockId: string,
): string {
  const block = splitBlocks(markdown).find((b) => b.index === blockIndex)
  if (!block || block.blockId) return markdown

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const targetLine = lines[block.endLine] ?? ""
  lines[block.endLine] = `${targetLine.replace(/[ \t]+$/, "")} ^${blockId}`
  return lines.join("\n")
}

/** 从文档中移除所有块 ID（用于清理/迁移） */
export function stripBlockIds(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (STANDALONE_ID_RE.test(line)) continue
    out.push(line.replace(TRAILING_ID_RE, ""))
  }
  return out.join("\n")
}
