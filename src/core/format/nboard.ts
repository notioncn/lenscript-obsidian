/**
 * `.nboard` 文件格式（Nestboard 兼容层）
 *
 * 目标：读写既有 `.nboard` 不丢任何字段。所有未识别的键原样保留，
 * 因此本文件只声明"镜语会用到/会渲染"的部分，其余交给 JSON 透传。
 *
 * 纯函数，不依赖 Obsidian，可直接 Node 单测。
 */

export const NBOARD_SPEC = "nestboard/1"

export type ThemeColor = "1" | "2" | "3" | "4" | "5" | "6"
export type BoardBackground = "plain" | "dots" | "grid" | "none"

export interface BoardMeta {
  id: string
  title: string
  icon: string | null
  createdAt: string
  updatedAt: string
  parent: string | null
  tags: string[]
  aliases: string[]
  [key: string]: unknown
}

export interface BoardViewState {
  x: number
  y: number
  zoom: number
  background: BoardBackground
  [key: string]: unknown
}

export interface BoardSettings {
  snapToGrid: boolean
  gridSize: number
  defaultCardColor: string
  readOnly: boolean
  [key: string]: unknown
}

export interface BoardColumn {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  collapsed: boolean
  color: string
  z: number
  [key: string]: unknown
}

export interface BoardCard {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  z: number
  columnId?: string | null
  order?: number
  color?: string
  accent?: string | null
  locked?: boolean
  showTitle?: boolean
  title?: string
  presentStep?: number | null
  rotation?: number
  collapsed?: boolean
  content: Record<string, unknown>
  [key: string]: unknown
}

export interface EdgeEndpoint {
  cardId: string
  side: "top" | "right" | "bottom" | "left" | null
  point?: { x: number; y: number }
  nodeId?: string
  [key: string]: unknown
}

export interface BoardEdge {
  id: string
  from: EdgeEndpoint
  to: EdgeEndpoint
  fromEnd?: "none" | "arrow"
  toEnd?: "none" | "arrow"
  style?: "solid" | "dashed"
  color?: string
  label?: string
  routing?: "free" | "smart" | "curve"
  kind?: "tree"
  [key: string]: unknown
}

export interface BoardGroup {
  id: string
  cardIds: string[]
  columnIds?: string[]
  label: string
  collapsed?: boolean
  [key: string]: unknown
}

export interface NBoardFile {
  spec: string
  version: number
  revision: number
  meta: BoardMeta
  view: BoardViewState
  settings: BoardSettings
  columns: BoardColumn[]
  cards: BoardCard[]
  edges: BoardEdge[]
  groups: BoardGroup[]
  minds?: unknown[]
  [key: string]: unknown
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback
}

export function parseNBoard(text: string): ParseResult<NBoardFile> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" }
  }
  if (!isRecord(raw)) return { ok: false, error: "无限画布文件不是对象" }
  if (raw.spec !== NBOARD_SPEC) {
    return { ok: false, error: `不是 ${NBOARD_SPEC} 文件（spec=${String(raw.spec)}）` }
  }
  if (!Array.isArray(raw.cards)) return { ok: false, error: "缺少 cards 数组" }

  const meta = isRecord(raw.meta) ? raw.meta : {}
  const view = isRecord(raw.view) ? raw.view : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}

  const board: NBoardFile = {
    ...raw,
    spec: NBOARD_SPEC,
    version: num(raw.version, 1),
    revision: num(raw.revision, 0),
    meta: {
      ...meta,
      id: str(meta.id, ""),
      title: str(meta.title, "未命名无限画布"),
      icon: typeof meta.icon === "string" ? meta.icon : null,
      createdAt: str(meta.createdAt, ""),
      updatedAt: str(meta.updatedAt, ""),
      parent: typeof meta.parent === "string" ? meta.parent : null,
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === "string") : [],
      aliases: Array.isArray(meta.aliases) ? meta.aliases.filter((t) => typeof t === "string") : [],
    },
    view: {
      ...view,
      x: num(view.x, 0),
      y: num(view.y, 0),
      zoom: num(view.zoom, 1),
      background: (["plain", "dots", "grid", "none"] as const).includes(
        view.background as BoardBackground,
      )
        ? (view.background as BoardBackground)
        : "dots",
    },
    settings: {
      ...settings,
      snapToGrid: settings.snapToGrid === true,
      gridSize: num(settings.gridSize, 16),
      defaultCardColor: str(settings.defaultCardColor, "1"),
      readOnly: settings.readOnly === true,
    },
    columns: (Array.isArray(raw.columns) ? raw.columns : [])
      .filter(isRecord)
      .map((c) => ({
        ...c,
        id: str(c.id, ""),
        title: str(c.title, ""),
        x: num(c.x, 0),
        y: num(c.y, 0),
        width: num(c.width, 320),
        height: num(c.height, 500),
        collapsed: c.collapsed === true,
        color: str(c.color, "#ffffff"),
        z: num(c.z, 1),
      })),
    cards: raw.cards.filter(isRecord).map((c) => ({
      ...c,
      id: str(c.id, ""),
      type: str(c.type, "note"),
      x: num(c.x, 0),
      y: num(c.y, 0),
      width: num(c.width, 260),
      height: num(c.height, 170),
      z: num(c.z, 1),
      content: isRecord(c.content) ? c.content : {},
    })),
    edges: (Array.isArray(raw.edges) ? raw.edges : [])
      .filter(isRecord)
      .filter((e) => isRecord(e.from) && isRecord(e.to))
      .map((e) => ({
        ...e,
        id: str(e.id, ""),
        from: e.from as EdgeEndpoint,
        to: e.to as EdgeEndpoint,
        fromEnd: e.fromEnd === "arrow" ? "arrow" : "none",
        toEnd: e.toEnd === "arrow" ? "arrow" : "none",
        style: e.style === "dashed" ? "dashed" : "solid",
        color: str(e.color, "1"),
        label: str(e.label, ""),
        routing: e.routing === "smart" || e.routing === "curve" ? e.routing : "free",
      })),
    groups: (Array.isArray(raw.groups) ? raw.groups : [])
      .filter(isRecord)
      .map((g) => ({
        ...g,
        id: str(g.id, ""),
        cardIds: Array.isArray(g.cardIds) ? g.cardIds.filter((x) => typeof x === "string") : [],
        label: str(g.label, ""),
      })),
  }

  return { ok: true, value: board }
}

export function stringifyNBoard(board: NBoardFile): string {
  return JSON.stringify(board, null, 2) + "\n"
}

let idCounter = 0

export function makeId(prefix: string): string {
  idCounter = (idCounter + 1) % 1296
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}${rand}${idCounter.toString(36)}`
}

export interface CreateBoardOptions {
  title?: string
  cardColor?: string
  snapToGrid?: boolean
  gridSize?: number
}

export function createNBoard(options: CreateBoardOptions = {}): NBoardFile {
  const now = new Date().toISOString()
  const title = options.title?.trim() || "未命名无限画布"
  return {
    spec: NBOARD_SPEC,
    version: 1,
    revision: 0,
    meta: {
      id: makeId("nb"),
      title,
      icon: null,
      createdAt: now,
      updatedAt: now,
      parent: null,
      tags: [],
      aliases: [],
    },
    view: { x: 0, y: 0, zoom: 1, background: "dots" },
    settings: {
      snapToGrid: options.snapToGrid ?? true,
      gridSize: options.gridSize ?? 16,
      defaultCardColor: options.cardColor ?? "1",
      readOnly: false,
    },
    columns: [],
    cards: [],
    edges: [],
    groups: [],
  }
}

export interface CardOptions {
  x?: number
  y?: number
  width?: number
  height?: number
  color?: string
  title?: string
  showTitle?: boolean
}

function baseCard(
  type: string,
  board: NBoardFile,
  opts: CardOptions,
): BoardCard {
  return {
    id: makeId("c"),
    type,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? 260,
    height: opts.height ?? 170,
    z: nextZ(board),
    columnId: null,
    order: 0,
    color: opts.color ?? board.settings.defaultCardColor,
    accent: null,
    locked: false,
    showTitle: opts.showTitle ?? true,
    title: opts.title ?? "",
    presentStep: null,
    content: {},
  }
}

export function createNoteCard(
  board: NBoardFile,
  md: string,
  opts: CardOptions = {},
): BoardCard {
  const card = baseCard("note", board, opts)
  card.content = { md, editorMode: "preview" }
  return card
}

export function createNoteRefCard(
  board: NBoardFile,
  path: string,
  opts: CardOptions & { subpath?: string | null; mode?: string; excerptLines?: number } = {},
): BoardCard {
  const card = baseCard("noteRef", board, opts)
  card.content = {
    path,
    subpath: opts.subpath ?? null,
    mode: opts.mode ?? "summary",
    excerptLines: opts.excerptLines ?? 6,
  }
  return card
}

export function createLinkCard(
  board: NBoardFile,
  url: string,
  title: string,
  opts: CardOptions = {},
): BoardCard {
  const card = baseCard("link", board, opts)
  card.content = {
    url,
    title,
    description: "",
    image: "",
    fetchedAt: null,
  }
  return card
}

export function createImageCard(
  board: NBoardFile,
  path: string,
  opts: CardOptions & { caption?: string } = {},
): BoardCard {
  const card = baseCard("image", board, opts)
  card.width = opts.width ?? 320
  card.height = opts.height ?? 240
  card.content = {
    path,
    caption: opts.caption ?? "",
    crop: { x: 0, y: 0, w: 1, h: 1 },
    fit: "cover",
  }
  return card
}

const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"])
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"])

/** 按扩展名创建文件 / PDF / 媒体 / Canvas 卡 */
export function createFileCard(
  board: NBoardFile,
  path: string,
  opts: CardOptions = {},
): BoardCard {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const type = ext === "pdf"
    ? "pdf"
    : ext === "canvas"
      ? "canvas"
      : VIDEO_EXT.has(ext)
        ? "video"
        : AUDIO_EXT.has(ext)
          ? "audio"
          : "file"
  const card = baseCard(type, board, opts)
  card.content = { path }
  return card
}

export function createBoardRefCard(
  board: NBoardFile,
  path: string,
  opts: CardOptions = {},
): BoardCard {
  const card = baseCard("boardRef", board, opts)
  card.width = opts.width ?? 120
  card.height = opts.height ?? 120
  card.content = { path, preview: "mini", showCount: true, icon: "📍" }
  return card
}

export function nextZ(board: NBoardFile): number {
  let max = 0
  for (const c of board.cards) max = Math.max(max, num(c.z, 0))
  for (const col of board.columns) max = Math.max(max, num(col.z, 0))
  return max + 1
}

export function findCard(board: NBoardFile, cardId: string): BoardCard | undefined {
  return board.cards.find((c) => c.id === cardId)
}

export function removeCard(board: NBoardFile, cardId: string): void {
  board.cards = board.cards.filter((c) => c.id !== cardId)
  board.edges = board.edges.filter(
    (e) => e.from.cardId !== cardId && e.to.cardId !== cardId,
  )
  for (const g of board.groups) {
    g.cardIds = g.cardIds.filter((id) => id !== cardId)
  }
}

/** 内容变化时调用：递增修订号并更新时间戳 */
export function touchNBoard(board: NBoardFile): void {
  board.revision = num(board.revision, 0) + 1
  board.meta.updatedAt = new Date().toISOString()
}

/** 从卡片里安全读取字符串字段 */
export function cardText(card: BoardCard, key: string, fallback = ""): string {
  const v = card.content[key]
  return typeof v === "string" ? v : fallback
}

export function cardNumber(card: BoardCard, key: string, fallback = 0): number {
  const v = card.content[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
