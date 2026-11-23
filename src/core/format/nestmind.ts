/**
 * `.nestmind` 文件格式（Nestboard 脑图兼容层）
 *
 * 与 `.nboard` 共用信封（spec / version / revision / meta / view），
 * 内容是一张扁平节点表（parentId 表达树）+ 可选关联线。
 *
 * 纯函数，不依赖 Obsidian。
 */

import type { BoardBackground } from "./nboard"
import { makeId } from "./nboard"

export const NESTMIND_SPEC = "nestmind/1"

export interface MindMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface MindViewState {
  x: number
  y: number
  zoom: number
  background: BoardBackground
  structure?: "logic-right" | "logic-left" | "octopus" | "org-down"
  edge?: "curve" | "line" | "elbow" | "rounded"
  outline?: boolean
  focus?: string
  [key: string]: unknown
}

export interface MindNodeStyle {
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  ink?: string
  highlight?: string
  [key: string]: unknown
}

export interface MindNode {
  id: string
  text: string
  note: string
  parentId: string | null
  order: number
  collapsed?: boolean
  free?: { x: number; y: number }
  style?: MindNodeStyle
  props?: Array<{ id: string; key: string; value: string | number | boolean }>
  refs?: Array<{ kind: string; path: string; width?: number }>
  icon?: string
  done?: boolean
  [key: string]: unknown
}

export interface MindLink {
  id: string
  from: string
  to: string
  label?: string
  arrow?: "end" | "both"
  solid?: boolean
  bend?: { x: number; y: number }
  color?: string
  [key: string]: unknown
}

export interface NestMindFile {
  spec: string
  version: number
  revision: number
  meta: MindMeta
  view: MindViewState
  rootId: string
  nodes: MindNode[]
  links?: MindLink[]
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

export function parseNestMind(text: string): ParseResult<NestMindFile> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" }
  }
  if (!isRecord(raw)) return { ok: false, error: "脑图文件不是对象" }
  if (raw.spec !== NESTMIND_SPEC) {
    return { ok: false, error: `不是 ${NESTMIND_SPEC} 文件（spec=${String(raw.spec)}）` }
  }
  if (!Array.isArray(raw.nodes)) return { ok: false, error: "缺少 nodes 数组" }

  const meta = isRecord(raw.meta) ? raw.meta : {}
  const view = isRecord(raw.view) ? raw.view : {}

  const nodes = raw.nodes
    .filter(isRecord)
    .map((n) => ({
      ...n,
      id: str(n.id, ""),
      text: str(n.text, ""),
      note: str(n.note, ""),
      parentId: typeof n.parentId === "string" ? n.parentId : null,
      order: num(n.order, 0),
      ...(n.collapsed === true ? { collapsed: true } : {}),
      ...(n.done === true ? { done: true } : {}),
    }))
    .filter((n) => n.id !== "")

  const rootId =
    typeof raw.rootId === "string" && nodes.some((n) => n.id === raw.rootId)
      ? raw.rootId
      : nodes.find((n) => n.parentId === null)?.id ?? ""

  const file: NestMindFile = {
    ...raw,
    spec: NESTMIND_SPEC,
    version: num(raw.version, 1),
    revision: num(raw.revision, 0),
    meta: {
      ...meta,
      id: str(meta.id, ""),
      title: str(meta.title, "未命名脑图"),
      createdAt: str(meta.createdAt, ""),
      updatedAt: str(meta.updatedAt, ""),
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
    rootId,
    nodes,
    ...(Array.isArray(raw.links)
      ? {
          links: raw.links
            .filter(isRecord)
            .filter((l) => typeof l.from === "string" && typeof l.to === "string")
            .map((l) => ({
              ...l,
              id: str(l.id, ""),
              from: l.from as string,
              to: l.to as string,
            })),
        }
      : {}),
  }

  return { ok: true, value: file }
}

export function stringifyNestMind(file: NestMindFile): string {
  return JSON.stringify(file, null, 2) + "\n"
}

export function createNestMind(title = "未命名脑图", rootText = "中心主题"): NestMindFile {
  const now = new Date().toISOString()
  const rootId = makeId("n")
  return {
    spec: NESTMIND_SPEC,
    version: 1,
    revision: 0,
    meta: {
      id: makeId("nm"),
      title,
      createdAt: now,
      updatedAt: now,
    },
    view: {
      x: 0,
      y: 0,
      zoom: 1,
      background: "dots",
      structure: "logic-right",
      edge: "curve",
    },
    rootId,
    nodes: [
      {
        id: rootId,
        text: rootText,
        note: "",
        parentId: null,
        order: 0,
      },
    ],
    links: [],
  }
}

export function mindNodeById(file: NestMindFile, id: string): MindNode | undefined {
  return file.nodes.find((n) => n.id === id)
}

export function mindChildren(file: NestMindFile, parentId: string): MindNode[] {
  return file.nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
}

export function mindRoot(file: NestMindFile): MindNode | undefined {
  return mindNodeById(file, file.rootId)
}

/** 深度优先展平（按 order） */
export function flattenMind(file: NestMindFile, includeCollapsed = true): MindNode[] {
  const out: MindNode[] = []
  const walk = (parentId: string) => {
    for (const node of mindChildren(file, parentId)) {
      out.push(node)
      if (includeCollapsed || !node.collapsed) walk(node.id)
    }
  }
  const root = mindRoot(file)
  if (!root) return out
  out.push(root)
  if (includeCollapsed || !root.collapsed) walk(root.id)
  return out
}

export function addMindChild(
  file: NestMindFile,
  parentId: string,
  text = "",
): MindNode {
  const siblings = mindChildren(file, parentId)
  const node: MindNode = {
    id: makeId("n"),
    text,
    note: "",
    parentId,
    order: siblings.length ? siblings[siblings.length - 1].order + 1 : 0,
  }
  file.nodes.push(node)
  touchNestMind(file)
  return node
}

export function removeMindNode(file: NestMindFile, nodeId: string): void {
  if (nodeId === file.rootId) return
  const doomed = new Set<string>([nodeId])
  let changed = true
  while (changed) {
    changed = false
    for (const n of file.nodes) {
      if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
        doomed.add(n.id)
        changed = true
      }
    }
  }
  file.nodes = file.nodes.filter((n) => !doomed.has(n.id))
  if (file.links) {
    file.links = file.links.filter((l) => !doomed.has(l.from) && !doomed.has(l.to))
  }
  touchNestMind(file)
}

export function touchNestMind(file: NestMindFile): void {
  file.revision = num(file.revision, 0) + 1
  file.meta.updatedAt = new Date().toISOString()
}
