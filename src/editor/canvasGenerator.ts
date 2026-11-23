/**
 * 画布生成器
 * 从 Obsidian Markdown 大纲生成原生 .canvas（JSON Canvas 1.0）或镜语 .nboard。
 *
 * 布局只在生成时算一次，规则：
 * - H1 = 文档根卡片，居中置顶；
 * - H2 = 横向分栏（一个场景 / 项目一栏），栏与栏之间留大间距；
 * - H3 = 栏内卡片，竖排在 H2 右侧；H4 及更深层折叠进所属 H3 卡片的正文，
 *   用加粗小标题分段，保证每张卡片都有真实正文；
 * - 连线只表达父子关系：根 → H2（下→上）、H2 → H3（右→左），
 *   不串同级、不自环，所以曲线始终沿层级方向走；
 * - 卡片高度按正文估算行数（CJK 按 2 个字符宽），超长正文截断并提示回原笔记，
 *   既不会重叠，也不会出现「大空框」。
 */

import type { TFile } from "obsidian"
import { MODEVOL_MARKER_REGEX, SCRIPT_MARKER_REGEX } from "../script-types"
import {
  createNBoard,
  createNoteCard,
  type NBoardFile,
} from "../core/format/nboard"

export interface CanvasNode {
  id: string
  type: "text" | "file" | "link" | "group"
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  file?: string
  label?: string
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: "top" | "right" | "bottom" | "left"
  toSide?: "top" | "right" | "bottom" | "left"
  fromEnd?: "none" | "arrow"
  toEnd?: "none" | "arrow"
  color?: string
  label?: string
}

export interface CanvasFile {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

// === 布局常量 ===
const CARD_W = 340
const CARD_PAD_Y = 14
/** Obsidian Canvas 文本卡默认 16px 字号 / 1.5 行高，按 24px 一行预留，避免底部被裁掉。 */
const LINE_H = 24
/** 卡片一行大约能放多少个「半角字符」（340 - 28 padding ≈ 312px，8px/单位）。 */
const UNITS_PER_LINE = 38
const CARD_GAP_X = 64
const CARD_GAP_Y = 32
const SECTION_GAP = 96
/** 根卡片与分栏之间的竖直留白，给根 → 分栏的连线走线用。 */
const ROOT_BAND = 160
const MAX_CARD_H = 620

const LEVEL_COLORS: Record<number, string> = {
  0: "4",
  1: "4",
  2: "3",
  3: "5",
}

/** 生成 16 字符唯一 ID */
function genId(): string {
  return Math.random().toString(16).slice(2, 18).padEnd(16, "0")
}

// === Markdown 大纲解析 ===

interface ContentBlock {
  kind: "para" | "list" | "quote" | "code"
  lines: string[]
}

interface Section {
  level: number
  title: string
  marker?: string
  blocks: ContentBlock[]
  children: Section[]
}

/** 去掉 YAML frontmatter，避免把属性当成正文。 */
function stripFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines
  const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line))
  return end > 0 ? lines.slice(end + 1) : lines
}

/** 把标题里的语义标记拆出来：`#e B · 产品矩阵` → 标题 + `#e`。 */
function splitHeading(raw: string): { title: string; marker?: string } {
  let text = raw.trim().replace(/\s+#+\s*$/, "")
  let marker: string | undefined

  const modevol = text.match(MODEVOL_MARKER_REGEX)
  if (modevol) {
    marker = `#${modevol[1]}`
    text = text.slice(modevol[0].length)
  } else {
    const script = text.match(SCRIPT_MARKER_REGEX)
    if (script) {
      marker = `${script[0].trim().startsWith("/") ? "/" : "#"}${script[1]}`
      text = text.slice(script[0].length)
    }
  }

  // Canvas 卡片里加粗标题本身就够醒目，去掉冗余强调符
  text = text.replace(/\*\*|__/g, "").trim()
  return { title: text || "未命名", marker }
}

function appendContent(section: Section, block: ContentBlock | null): void {
  if (block && block.lines.length > 0) section.blocks.push(block)
}

/**
 * 按标题层级建树。
 * 普通段落 / 列表 / 引用 / 代码块挂到最近的标题下，重复的纯标记行（#e、/s）跳过。
 */
function parseOutline(content: string, fallbackTitle: string): Section {
  const root: Section = { level: 0, title: fallbackTitle, blocks: [], children: [] }
  const stack: Section[] = [root]
  let current = root
  let block: ContentBlock | null = null
  let blockOwner: Section | null = null
  let inFence = false

  const flush = (): void => {
    if (block && blockOwner) appendContent(blockOwner, block)
    block = null
    blockOwner = null
  }

  for (const raw of stripFrontmatter(content.split(/\r?\n/))) {
    const line = raw.replace(/\s+$/, "")

    if (inFence) {
      if (/^```/.test(line.trim())) {
        if (block) block.lines.push("```")
        inFence = false
        flush()
      } else if (block && block.lines.length < 10) {
        block.lines.push(line)
      }
      continue
    }

    if (/^```/.test(line.trim())) {
      flush()
      block = { kind: "code", lines: [line.trim()] }
      blockOwner = current
      inFence = true
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }

    // 整行注释 / 分隔线不进卡片
    if (/^%%.*%%$/.test(line.trim()) || /^---+$/.test(line.trim())) {
      flush()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flush()
      const level = heading[1].length
      const { title, marker } = splitHeading(heading[2])
      const section: Section = { level, title, marker, blocks: [], children: [] }
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      stack[stack.length - 1].children.push(section)
      stack.push(section)
      current = section
      continue
    }

    const trimmed = line.trim()
    // 只有语义标记、没有内容的行（例如单独的 #e）没有展示价值
    if (/^(?:#[devtc]|\/[sarxlp])$/.test(trimmed)) continue

    const kind: ContentBlock["kind"] = /^>/.test(trimmed)
      ? "quote"
      : /^(?:[-*+]|\d+\.)\s+/.test(trimmed)
        ? "list"
        : "para"

    if (!block || block.kind !== kind || blockOwner !== current) {
      flush()
      block = { kind, lines: [] }
      blockOwner = current
    }
    block.lines.push(line)
  }

  if (inFence && block) block.lines.push("```")
  flush()
  return root
}

// === 文本度量与卡片 ===

function isWide(ch: string): boolean {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
}

/** 粗略估算一行的显示宽度（半角=1，全角=2），用于算换行与卡片高度。 */
function textUnits(line: string): number {
  const plain = line
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[\s>]*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/[*_`~]/g, "")
  let units = 0
  for (const ch of plain) units += isWide(ch) ? 2 : 1
  return units
}

function visualLines(line: string): number {
  return Math.max(1, Math.ceil(textUnits(line) / UNITS_PER_LINE))
}

/** 把一行按可用宽度截断，末尾加省略号。 */
function ellipsize(line: string, maxLines: number): string {
  const budget = Math.max(0, maxLines * UNITS_PER_LINE - 2)
  let units = 0
  let out = ""
  for (const ch of line) {
    const width = isWide(ch) ? 2 : 1
    if (units + width > budget) break
    units += width
    out += ch
  }
  return `${out.trimEnd()}…`
}

function cleanInline(line: string): string {
  return line.replace(/%%[\s\S]*?%%/g, "").trimEnd()
}

function renderBlock(block: ContentBlock): string[] {
  if (block.kind === "code") return block.lines
  const lines =
    block.kind === "quote"
      ? block.lines.map((line) => (line.trim().startsWith(">") ? line : `> ${line}`))
      : block.lines
  return lines
    .map(cleanInline)
    .filter((line) => (block.kind === "quote" ? line.replace(/^[\s>]+/, "").trim() !== "" : line.trim() !== ""))
}

interface CardDraft {
  text: string
  height: number
}

/** 深层子标题也折进卡片正文，避免出现「已完成 / 待推进」这种脱离上下文的孤立卡片。 */
function appendDescendants(section: Section, out: string[]): void {
  for (const child of section.children) {
    out.push("")
    out.push(`**${child.title}**`)
    for (const block of child.blocks) out.push(...renderBlock(block))
    appendDescendants(child, out)
  }
}

/**
 * 生成一张卡片的正文与高度。
 * @param maxBodyLines 正文最多显示多少视觉行，超出截断
 * @param includeDescendants 是否把更深层子标题折进正文
 */
function buildCard(section: Section, maxBodyLines: number, includeDescendants: boolean): CardDraft {
  const head: string[] = []
  // 标记用行内代码包住，否则 Canvas 会把 `#e` 当成一级标题渲染
  if (section.marker) head.push(`\`${section.marker}\``)
  head.push(`**${section.title}**`)

  const body: string[] = []
  for (const block of section.blocks) {
    const rendered = renderBlock(block)
    if (body.length > 0 && body[body.length - 1] !== "") body.push("")
    body.push(...rendered)
  }
  if (includeDescendants) appendDescendants(section, body)
  else if (body.length === 0 && section.children.length > 0) body.push(`共 ${section.children.length} 个分支`)

  // 正文上限还要受卡片最大高度约束，否则 Obsidian 会直接把超出部分裁掉
  const headLines = head.reduce((sum, line) => sum + visualLines(line), 0)
  const capByHeight = Math.floor((MAX_CARD_H - CARD_PAD_Y * 2) / LINE_H) - headLines - 1
  const bodyLimit = Math.max(1, Math.min(maxBodyLines, capByHeight))

  let used = 0
  let truncated = false
  const kept: string[] = []
  for (const line of body) {
    const lines = visualLines(line)
    if (used + lines > bodyLimit) {
      const remain = bodyLimit - used
      if (remain >= 1) kept.push(ellipsize(line, remain))
      truncated = true
      break
    }
    kept.push(line)
    used += lines
  }
  if (truncated) kept.push("…（内容较长，完整内容见原笔记）")

  const lines = [...head, ...kept]
  const height = Math.max(
    84,
    CARD_PAD_Y * 2 + lines.reduce((sum, line) => sum + visualLines(line), 0) * LINE_H,
  )
  return { text: lines.join("\n"), height }
}

// === 布局 ===

function makeEdge(fromNode: string, toNode: string, fromSide: CanvasEdge["fromSide"], toSide: CanvasEdge["toSide"]): CanvasEdge {
  return { id: genId(), fromNode, toNode, fromSide, toSide, toEnd: "arrow", color: "2" }
}

/**
 * 从 Markdown 剧本生成 Canvas。
 *
 * 坐标全部按「根在顶部居中、场景从左到右分栏、子卡片在栏内竖排」计算，
 * 每张卡片的 y 由上一张的 y + height + gap 推出来，因此不可能重叠。
 */
export function generateCanvasFromContent(content: string, sourceFile?: TFile): CanvasFile {
  const fallbackTitle = sourceFile?.basename?.trim() || "未命名文档"
  const parsed = parseOutline(content, fallbackTitle)

  // 多个 H1 时造一个虚拟根，把每个 H1 当作一栏；单个 H1 直接作为文档根
  const h1s = parsed.children.filter((section) => section.level === 1)
  let docRoot = parsed
  if (h1s.length === 1) {
    docRoot = h1s[0]
  } else if (h1s.length > 1) {
    docRoot = { level: 0, title: fallbackTitle, blocks: parsed.blocks, children: h1s }
  }

  const sectionNodes: CanvasNode[] = []
  const childNodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  const rootDraft = buildCard(docRoot, docRoot.children.length > 0 ? 8 : 24, docRoot.children.length === 0)
  const rootNode: CanvasNode = {
    id: genId(),
    type: "text",
    x: 0,
    y: 0,
    width: CARD_W,
    height: rootDraft.height,
    color: LEVEL_COLORS[docRoot.level] ?? "4",
    text: rootDraft.text,
  }

  const contentY = rootDraft.height + ROOT_BAND
  let cursorX = 0

  for (const section of docRoot.children) {
    const hasChildren = section.children.length > 0
    const sectionDraft = buildCard(section, hasChildren ? 12 : 24, !hasChildren)
    const sectionNode: CanvasNode = {
      id: genId(),
      type: "text",
      x: cursorX,
      y: contentY,
      width: CARD_W,
      height: sectionDraft.height,
      color: LEVEL_COLORS[section.level] ?? "3",
      text: sectionDraft.text,
    }
    sectionNodes.push(sectionNode)
    edges.push(makeEdge(rootNode.id, sectionNode.id, "bottom", "top"))

    const childX = cursorX + CARD_W + CARD_GAP_X
    let childY = contentY
    for (const child of section.children) {
      const draft = buildCard(child, 22, true)
      const childNode: CanvasNode = {
        id: genId(),
        type: "text",
        x: childX,
        y: childY,
        width: CARD_W,
        height: draft.height,
        color: LEVEL_COLORS[child.level] ?? "5",
        text: draft.text,
      }
      childNodes.push(childNode)
      edges.push(makeEdge(sectionNode.id, childNode.id, "right", "left"))
      childY += childNode.height + CARD_GAP_Y
    }

    const sectionWidth = CARD_W + (hasChildren ? CARD_GAP_X + CARD_W : 0)
    cursorX += sectionWidth + SECTION_GAP
  }

  const totalWidth = Math.max(CARD_W, cursorX - SECTION_GAP)
  rootNode.x = Math.round((totalWidth - CARD_W) / 2)

  // 没有标题也没有正文的文档，仍给一张提示卡，避免生成空文件
  if (sectionNodes.length === 0 && childNodes.length === 0 && docRoot.blocks.length === 0) {
    rootNode.text = `**${docRoot.title}**\n\n（这篇笔记还没有可展开的标题或正文）`
    rootNode.height = 110
  }

  return { nodes: [rootNode, ...sectionNodes, ...childNodes], edges }
}

/** 复用同一套大纲布局，生成镜语无限画布（.nboard）。 */
export function generateNBoardFromContent(
  content: string,
  sourceFile?: TFile,
  options: { title?: string; gridSize?: number } = {},
): NBoardFile {
  const canvas = generateCanvasFromContent(content, sourceFile)
  const board = createNBoard({
    title: options.title ?? sourceFile?.basename ?? "未命名无限画布",
    gridSize: options.gridSize,
  })
  const cardIds = new Map<string, string>()

  for (const node of canvas.nodes) {
    const card = createNoteCard(board, node.text ?? "", {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      color: node.color,
      title: "",
      showTitle: false,
    })
    board.cards.push(card)
    cardIds.set(node.id, card.id)
  }

  for (const edge of canvas.edges) {
    const fromCardId = cardIds.get(edge.fromNode)
    const toCardId = cardIds.get(edge.toNode)
    if (!fromCardId || !toCardId) continue
    board.edges.push({
      id: edge.id,
      from: { cardId: fromCardId, side: edge.fromSide ?? null },
      to: { cardId: toCardId, side: edge.toSide ?? null },
      fromEnd: edge.fromEnd,
      toEnd: edge.toEnd,
      color: edge.color,
      label: edge.label,
    })
  }

  return board
}

/** Canvas JSON 序列化为 .canvas 文件内容 */
export function serializeCanvas(canvas: CanvasFile): string {
  return JSON.stringify(canvas, null, 2)
}
