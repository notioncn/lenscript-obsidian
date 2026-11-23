/**
 * OutlineStore — Obsidian 适配层
 *
 * 单例，插件实例持有。负责：
 *   - Markdown → OutlineNode 树（调用 core/outline）
 *   - .lens.json 读写（折叠/位置/自定义节点）
 *   - 事件广播（treeChanged / layoutChanged）给 OutlineView & MindmapView
 *
 * 不自己改 Markdown（用户的 heading/marker 是真相源）；
 * reparent/collapse/x/y 这类 UI 操作只写 .lens.json，"回写 Markdown" 走独立命令。
 */

import {
  buildTree,
  mergeLayout,
  reparent,
  serializeLayout,
  flattenAll,
  type OutlineNode,
  type SavedNode,
} from "../core/outline"
import {
  addChildNode,
  removeNode,
} from "../core/outline"
import type { ScriptMarkerType } from "../script-types"
import type { App } from "obsidian"
import { TFile } from "obsidian"

export interface OutlineState {
  roots: OutlineNode[]
  extras: OutlineNode[]
  saved: SavedNode[]
  treeVersion: number
  layoutVersion: number
}

export type OutlineEvent =
  | "tree"       // 树结构变了（reparent/remove/add）
  | "layout"     // 位置/折叠变了
  | "file-change" // 底层 Markdown 被改（外部）

type Listener = (state: OutlineState, ev: OutlineEvent) => void

const SIDEBAR_VERSION = 1
const SIDEBAR_KEY = "_lens_outline" // 在 lens.json 里的 key

export class OutlineStore {
  app: App
  private file: TFile | null = null
  private roots: OutlineNode[] = []
  private extras: OutlineNode[] = []
  private saved: SavedNode[] = []
  private treeVersion = 0
  private layoutVersion = 0
  private listeners: Listener[] = []
  private dirty = false
  private saveTimer: number | null = null
  // 用于去抖 Markdown 外部修改（vault modify 会触发）
  private lastContentHash = ""

  constructor(app: App) {
    this.app = app
  }

  get state(): OutlineState {
    return {
      roots: this.roots,
      extras: this.extras,
      saved: this.saved,
      treeVersion: this.treeVersion,
      layoutVersion: this.layoutVersion,
    }
  }

  /** 订阅变更，返回取消函数 */
  onChange(fn: Listener): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn)
    }
  }

  private emit(ev: OutlineEvent): void {
    const state = this.state
    for (const fn of [...this.listeners]) {
      try { fn(state, ev) } catch {}
    }
  }

  private sidecarPath(): string | null {
    if (!this.file) return null
    const parent = this.file.parent?.path
    if (!parent || parent === "/") return `${this.file.basename}.lens.json`
    return `${parent}/${this.file.basename}.lens.json`
  }

  async load(file: TFile): Promise<void> {
    this.file = file
    const md = await this.app.vault.read(file)
    this.rebuildFromMarkdown(md, false)

    const path = this.sidecarPath()!
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      try {
        const data = JSON.parse(await this.app.vault.read(existing))
        if (Array.isArray(data?.[SIDEBAR_KEY])) {
          this.saved = data[SIDEBAR_KEY] as SavedNode[]
        }
      } catch {}
    }
    const merged = mergeLayout(this.roots, this.saved)
    this.extras = merged.extras
    this.treeVersion++
    this.layoutVersion++
    this.lastContentHash = md
    this.emit("file-change")
  }

  /**
   * 外部 Markdown 修改后的重建。用当前 saved 合并进新树，保留 UI 状态。
   */
  rebuildFromMarkdown(md: string, emit = true): void {
    this.roots = buildTree(md)
    this.extras = []
    this.treeVersion++
    // 不 emit；load() 会统一 emit
    if (emit) this.emit("file-change")
  }

  /** 整文档被 modify 时调：去抖 + 合并布局 */
  async handleFileModify(): Promise<void> {
    if (!this.file) return
    const md = await this.app.vault.read(this.file)
    const hash = md
    if (hash === this.lastContentHash) return
    this.lastContentHash = hash
    this.rebuildFromMarkdown(md, false)
    const merged = mergeLayout(this.roots, this.saved)
    this.extras = merged.extras
    this.layoutVersion++
    this.emit("tree")
  }

  // ===== 树操作（调纯函数 + 持久化 + emit）=====

  reparent(nodeId: string, newParentId: string, siblingAt?: string): boolean {
    const res = reparent(this.roots, nodeId, newParentId, siblingAt)
    if (!res.ok) return false
    this.roots = res.tree
    this.treeVersion++
    this.scheduleSave()
    this.emit("tree")
    return true
  }

  remove(nodeId: string): void {
    const flat = flattenAll(this.roots)
    const node = flat.find((n) => n.id === nodeId)
    removeNode(this.roots, nodeId)
    // 同步 saved：被移除节点的 saved node 也去掉
    if (node) {
      this.saved = this.saved.filter((s) => s.id !== nodeId)
    }
    this.treeVersion++
    this.scheduleSave()
    this.emit("tree")
  }

  addChild(
    parentId: string | "root",
    kind: "paragraph" | "heading",
    label: string,
    marker?: ScriptMarkerType,
  ): OutlineNode | null {
    const node = addChildNode(this.roots, parentId, kind, label, marker)
    if (!node) return null
    // 加到 saved 里
    this.saved.push({ id: node.id, custom: true, customText: label })
    if (node.parentId === "root") node.parentId = undefined
    this.extras.push(node)
    this.treeVersion++
    this.scheduleSave()
    this.emit("tree")
    return node
  }

  // ===== 布局操作 =====

  setCollapsed(nodeId: string, collapsed: boolean): void {
    const flat = flattenAll(this.roots)
    const node = flat.find((n) => n.id === nodeId) ?? this.extras.find((n) => n.id === nodeId)
    if (!node) return
    node.collapsed = collapsed
    this.saved = this.saved.filter((s) => s.id !== nodeId)
    this.saved.push({ id: nodeId, collapsed })
    this.layoutVersion++
    this.scheduleSave()
    this.emit("layout")
  }

  setPosition(nodeId: string, x: number, y: number): void {
    const flat = flattenAll(this.roots)
    const node = flat.find((n) => n.id === nodeId) ?? this.extras.find((n) => n.id === nodeId)
    if (!node) return
    node.x = x
    node.y = y
    this.saved = this.saved.filter((s) => s.id !== nodeId)
    this.saved.push({ id: nodeId, x, y })
    this.layoutVersion++
    this.scheduleSave()
    this.emit("layout")
  }

  // ===== 持久化 =====

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.persist(), 300)
  }

  async persist(): Promise<void> {
    if (!this.file || !this.dirty) return
    const path = this.sidecarPath()!
    const data: Record<string, unknown> = {
      version: SIDEBAR_VERSION,
      [SIDEBAR_KEY]: serializeLayout(this.roots, this.extras),
    }
    try {
      const existing = this.app.vault.getAbstractFileByPath(path)
      const content = JSON.stringify(data, null, 2)
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content)
      } else {
        await this.app.vault.adapter.write(path, content)
      }
      this.dirty = false
    } catch (e) {
      console.warn("[OutlineStore] persist failed", e)
    }
  }
}

/** 供 UI 层：把 TFile 的 Markdown 路径转成 .lens.json 路径字符串（vault 相对） */
export function sidecarPathOf(file: TFile): string {
  const parent = file.parent?.path
  if (!parent || parent === "/") return `${file.basename}.lens.json`
  return `${parent}/${file.basename}.lens.json`
}
