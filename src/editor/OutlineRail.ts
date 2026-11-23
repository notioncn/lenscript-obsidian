/**
 * 编辑器边缘标题导轨（吸收 gogoga-outline 的核心交互）
 *
 * 静息时是一列短横线；鼠标沿导轨移动时按高斯衰减形成"波峰"，
 * 波峰旁浮出章节预览；停留片刻展开完整大纲，点击任意标题跳转原文。
 *
 * 数据直接来自 `buildTree(markdown)`（与大纲视图、导图同源），
 * 因此脚本 marker / heading 的层级变化会立即反映到导轨上。
 */

import { MarkdownView } from "obsidian"
import type { App, Plugin } from "obsidian"
import { buildTree, flattenAll, type OutlineNode } from "../core/outline"

export interface RailSettings {
  enabled: boolean
  side: "left" | "right"
  minHeadings: number
  showPreview: boolean
  expandMode: "dwell" | "hotkey"
  dwellDelay: number
  panelWidth: number
  panelMaxLevel: number
  stayOpen: boolean
}

export const DEFAULT_RAIL_SETTINGS: RailSettings = {
  enabled: true,
  side: "right",
  minHeadings: 1,
  showPreview: true,
  expandMode: "dwell",
  dwellDelay: 420,
  panelWidth: 320,
  panelMaxLevel: 3,
  stayOpen: false,
}

interface HeadingInfo {
  node: OutlineNode
  index: number
  level: number
  text: string
  preview: string
}

const CLOSE_GRACE = 320
const DWELL_TOL = 6

export class RailManager {
  private app: App
  private plugin: Plugin
  private settings: () => RailSettings
  private rails = new Map<MarkdownView, OutlineRail>()
  private rebuildTimer: number | null = null

  constructor(app: App, plugin: Plugin, settings: () => RailSettings) {
    this.app = app
    this.plugin = plugin
    this.settings = settings
  }

  start(): void {
    this.plugin.registerEvent(
      this.app.workspace.on("layout-change", () => this.syncAll()),
    )
    this.plugin.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncAll()),
    )
    this.plugin.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.syncAll()
        // 切换文件时必须重新读当前编辑器内容；只 syncAll 会沿用上一篇的标题刻度
        this.scheduleRebuildAll()
      }),
    )
    this.plugin.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.scheduleRebuildAll()
      }),
    )
    this.syncAll()
  }

  dispose(): void {
    if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer)
    for (const rail of this.rails.values()) rail.destroy()
    this.rails.clear()
  }

  refreshSettings(): void {
    for (const rail of this.rails.values()) rail.applySettings(this.settings())
  }

  private scheduleRebuildAll(): void {
    if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer)
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null
      for (const rail of this.rails.values()) rail.rebuild()
    }, 180)
  }

  private syncAll(): void {
    const leaves = this.app.workspace.getLeavesOfType("markdown")
    const alive = new Set<MarkdownView>()

    for (const leaf of leaves) {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) continue
      alive.add(view)
      if (!this.rails.has(view)) {
        const rail = new OutlineRail(this.app, view, this.settings())
        rail.mount()
        this.rails.set(view, rail)
      }
    }
    for (const [view, rail] of this.rails) {
      if (!alive.has(view) || !view.contentEl.isConnected) {
        rail.destroy()
        this.rails.delete(view)
      }
    }

    for (const rail of this.rails.values()) rail.applySettings(this.settings())
  }
}

class OutlineRail {
  private app: App
  private view: MarkdownView
  private settings: RailSettings

  private el!: HTMLElement
  private listEl!: HTMLElement
  private previewEl!: HTMLElement
  private previewTitle!: HTMLElement
  private previewBody!: HTMLElement
  private panelEl!: HTMLElement
  private panelListEl!: HTMLElement

  private headings: HeadingInfo[] = []
  private ticks: HTMLElement[] = []
  private rows: HTMLElement[] = []
  private rowParents: number[] = []

  private expanded = false
  private pinned = false
  private hoverIndex = -1
  private focusIndex = -1
  private dwellTimer = 0
  private closeTimer = 0
  private dwellAnchor: { x: number; y: number } | null = null
  private lastMouseY = 0
  private waveRaf = 0
  private onScrollBound = () => {
    // 滚动时只收起预览，不按鼠标位置制造波峰
    this.previewEl?.removeClass("is-visible")
    this.setFocus(-1)
  }
  private scroller: HTMLElement | null = null
  private readonly onDocKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this.expanded) return
    e.preventDefault()
    e.stopPropagation()
    this.collapse()
  }

  constructor(app: App, view: MarkdownView, settings: RailSettings) {
    this.app = app
    this.view = view
    this.settings = settings
  }

  mount(): void {
    if (this.el) return
    const host = this.view.contentEl
    if (!host) return
    host.addClass("ls-rail-host")

    this.el = host.createDiv({ cls: "ls-rail" })
    this.listEl = this.el.createDiv({ cls: "ls-rail-list" })

    this.previewEl = this.el.createDiv({ cls: "ls-rail-preview" })
    this.previewTitle = this.previewEl.createDiv({ cls: "ls-rail-preview-title" })
    this.previewBody = this.previewEl.createDiv({ cls: "ls-rail-preview-body" })

    this.panelEl = this.el.createDiv({ cls: "ls-rail-panel" })
    const head = this.panelEl.createDiv({ cls: "ls-rail-panel-head" })
    head.setText("大纲")
    this.panelListEl = this.panelEl.createDiv({ cls: "ls-rail-panel-list" })

    this.el.addEventListener("mousemove", (e) => this.onMouseMove(e))
    this.el.addEventListener("mouseleave", () => this.onLeave())
    this.panelEl.addEventListener("mouseenter", () => this.cancelClose())
    this.panelEl.addEventListener("mouseleave", () => this.onLeave())
    this.el.addEventListener("click", () => this.pinIfNeeded())

    this.applySettings(this.settings)
    this.rebuild()
    this.attachScroll()
  }

  destroy(): void {
    this.cancelDwell()
    this.cancelClose()
    if (this.waveRaf) cancelAnimationFrame(this.waveRaf)
    this.detachScroll()
    document.removeEventListener("keydown", this.onDocKey, true)
    this.el?.remove()
    this.view.contentEl?.removeClass("ls-rail-host")
  }

  applySettings(s: RailSettings): void {
    const prevMin = this.settings.minHeadings
    this.settings = s
    if (!this.el) return
    this.el.toggleClass("ls-rail-hidden", !s.enabled)
    this.el.toggleClass("is-left", s.side === "left")
    this.el.toggleClass("is-right", s.side !== "left")
    this.panelEl.style.setProperty("--ls-panel-width", `${s.panelWidth}px`)
    if (prevMin !== s.minHeadings) this.rebuild()
    else this.rebuildPanel()
  }

  // ============ 数据 ============

  rebuild(): void {
    if (!this.el || !this.view.file) return
    const md = this.view.editor.getValue()
    const roots = buildTree(md)
    const all = flattenAll(roots).sort((a, b) => a.startLine - b.startLine)
    const headings = all.filter((n) => n.kind === "heading")
    const lines = md.replace(/\r\n?/g, "\n").split("\n")

    this.headings = headings.map((node, index) => {
      const next = headings[index + 1]
      const end = next ? next.startLine : lines.length
      const preview = lines
        .slice(node.endLine + 1, Math.min(end, node.endLine + 7))
        .join("\n")
        .trim()
      return {
        node,
        index,
        level: node.level ?? 1,
        text: node.text || "（无标题）",
        preview,
      }
    })

    this.renderTicks()
    this.rebuildPanel()
    this.syncLayout()
  }

  private renderTicks(): void {
    this.listEl.empty()
    this.ticks = []
    const visible = this.headings.length >= this.settings.minHeadings
    this.el.toggleClass("ls-rail-empty", !visible)
    if (!visible) return

    const minLevel = this.headings.reduce((m, h) => Math.min(m, h.level), 6)
    for (const h of this.headings) {
      const tick = this.listEl.createDiv({ cls: "ls-rail-item" })
      tick.dataset.index = String(h.index)
      const dash = tick.createDiv({ cls: "ls-rail-tick" })
      // 静息时所有刻度统一 12×2，与 gogoga-outline 一致；层级只影响面板缩进
      dash.style.width = "12px"
      dash.style.height = "2px"
      void minLevel
      tick.addEventListener("click", (e) => {
        e.stopPropagation()
        this.jumpTo(h.node)
      })
      tick.addEventListener("mouseenter", () => {
        this.hoverIndex = h.index
        this.showPreview(h)
      })
      this.ticks.push(tick)
    }
    this.updateActive()
  }

  /** 当前光标所在章节的刻度用强调色 */
  private updateActive(): void {
    if (!this.ticks.length) return
    const line = this.view.editor.getCursor().line
    let active = -1
    for (const h of this.headings) {
      if (h.node.startLine <= line) active = h.index
      else break
    }
    this.ticks.forEach((item, i) => item.toggleClass("is-active", i === active))
  }

  private rebuildPanel(): void {
    if (!this.panelListEl) return
    this.panelListEl.empty()
    this.rows = []
    this.rowParents = []
    this.focusIndex = -1
    if (!this.headings.length) return

    const base = this.headings.reduce((m, h) => Math.min(m, h.level), 6)
    const cap = base + Math.max(1, this.settings.panelMaxLevel) - 1
    const stack: number[] = []
    let shown = 0

    for (const h of this.headings) {
      if (h.level > cap) continue
      const depth = Math.max(0, h.level - base)
      while (stack.length && this.headings[stack[stack.length - 1]].level >= h.level) {
        stack.pop()
      }
      this.rowParents.push(stack.length ? stack[stack.length - 1] : -1)
      stack.push(h.index)

      const row = this.panelListEl.createDiv({ cls: "ls-rail-row" })
      row.dataset.depth = String(Math.min(depth, 3))
      row.style.paddingInlineStart = `${8 + depth * 14}px`
      row.style.setProperty("--ls-row-delay", `${Math.min(shown, 12) * 16}ms`)
      row.setText(h.text)
      row.addEventListener("click", (e) => {
        e.stopPropagation()
        this.jumpTo(h.node)
      })
      row.addEventListener("mouseenter", () => this.setFocus(h.index))
      this.rows.push(row)
      shown++
    }
  }

  // ============ 交互 ============

  private onMouseMove(e: MouseEvent): void {
    this.lastMouseY = e.clientY
    this.queueWave(e.clientY)

    if (this.settings.expandMode === "dwell" && !this.expanded) {
      const a = this.dwellAnchor
      if (
        a &&
        Math.abs(e.clientX - a.x) < DWELL_TOL &&
        Math.abs(e.clientY - a.y) < DWELL_TOL
      ) {
        return
      }
      this.dwellAnchor = { x: e.clientX, y: e.clientY }
      this.cancelDwell()
      this.dwellTimer = window.setTimeout(() => this.expand(false), this.settings.dwellDelay)
    }
  }

  private queueWave(mouseY: number): void {
    if (this.waveRaf) return
    this.waveRaf = requestAnimationFrame(() => {
      this.waveRaf = 0
      this.wave(mouseY)
    })
  }

  private wave(mouseY: number): void {
    if (!this.ticks.length) return
    const rect = this.listEl.getBoundingClientRect()
    const sigma = 22
    let nearest = -1
    let nearestDist = Infinity

    this.ticks.forEach((tick, i) => {
      const r = tick.getBoundingClientRect()
      const dy = mouseY - (r.top + r.height / 2)
      const d = Math.abs(dy)
      const boost = Math.exp(-(dy * dy) / (2 * sigma * sigma))
      const dash = tick.querySelector<HTMLElement>(".ls-rail-tick")
      if (dash) {
        dash.style.width = `${12 + 34 * boost}px`
        dash.style.height = `${2 + 2 * boost}px`
      }
      if (d < nearestDist) {
        nearestDist = d
        nearest = i
      }
    })

    this.ticks.forEach((tick, i) => tick.toggleClass("is-crest", i === nearest))

    if (nearest >= 0 && nearestDist < 40) {
      const h = this.headings[nearest]
      this.hoverIndex = h.index
      this.showPreview(h)
    }
  }

  private showPreview(h: HeadingInfo): void {
    if (!this.settings.showPreview) {
      this.previewEl.removeClass("is-visible")
      return
    }
    this.previewEl.addClass("is-visible")
    this.previewTitle.setText(h.text)
    this.previewBody.setText(h.preview || "（本节暂无正文）")
    const tick = this.ticks[h.index]
    if (tick) {
      const railRect = this.el.getBoundingClientRect()
      const r = tick.getBoundingClientRect()
      const top = r.top - railRect.top + r.height / 2
      this.previewEl.style.top = `${Math.max(8, top)}px`
    }
  }

  private onLeave(): void {
    this.cancelDwell()
    this.previewEl.removeClass("is-visible")
    for (const tick of this.ticks) {
      tick.removeClass("is-crest")
      const dash = tick.querySelector<HTMLElement>(".ls-rail-tick")
      if (dash) {
        dash.style.width = "12px"
        dash.style.height = "2px"
      }
    }
    if (!this.expanded || this.pinned) return
    this.cancelClose()
    this.closeTimer = window.setTimeout(() => this.collapse(), CLOSE_GRACE)
  }

  private cancelDwell(): void {
    if (this.dwellTimer) window.clearTimeout(this.dwellTimer)
    this.dwellTimer = 0
    this.dwellAnchor = null
  }

  private cancelClose(): void {
    if (this.closeTimer) window.clearTimeout(this.closeTimer)
    this.closeTimer = 0
  }

  private expand(pinned: boolean): void {
    if (this.headings.length < this.settings.minHeadings) return
    this.cancelDwell()
    this.cancelClose()
    if (pinned) this.pinned = true
    if (this.expanded) return
    this.expanded = true
    this.el.addClass("is-expanded")
    this.previewEl.removeClass("is-visible")
    const host = this.view.contentEl.getBoundingClientRect()
    this.panelEl.style.maxHeight = `${Math.round(host.height * 0.8)}px`
    const start = this.hoverIndex >= 0 ? this.hoverIndex : 0
    this.setFocus(start)
    document.addEventListener("keydown", this.onDocKey, true)
  }

  private collapse(): void {
    this.cancelDwell()
    this.cancelClose()
    if (!this.expanded) return
    this.expanded = false
    this.pinned = false
    this.el.removeClass("is-expanded")
    this.setFocus(-1)
    document.removeEventListener("keydown", this.onDocKey, true)
    if (this.panelEl.contains(document.activeElement)) {
      document.activeElement instanceof HTMLElement && document.activeElement.blur()
      this.view.editor.focus()
    }
  }

  private setFocus(index: number): void {
    if (this.focusIndex >= 0) this.rows[this.focusIndex]?.removeClass("is-focus")
    this.focusIndex = index
    if (index >= 0) this.rows[index]?.addClass("is-focus")
  }

  private pinIfNeeded(): void {
    if (this.expanded && this.settings.stayOpen) {
      this.pinned = true
      this.cancelClose()
    }
  }

  private jumpTo(node: OutlineNode): void {
    const editor = this.view.editor
    const line = Math.min(node.startLine, Math.max(0, editor.lineCount() - 1))
    const pos = { line, ch: 0 }
    editor.setCursor(pos)
    editor.scrollIntoView({ from: pos, to: pos }, true)
    editor.focus()
    if (!this.settings.stayOpen) this.collapse()
  }

  // ============ 滚动同步 ============

  private attachScroll(): void {
    this.detachScroll()
    const candidate = this.view.contentEl.querySelector<HTMLElement>(".cm-scroller")
    if (candidate) {
      this.scroller = candidate
      candidate.addEventListener("scroll", this.onScrollBound, { passive: true })
    }
  }

  private detachScroll(): void {
    this.scroller?.removeEventListener("scroll", this.onScrollBound)
    this.scroller = null
  }

  /** 视图内层滚动时重建导轨位置（内容尺寸变化可能来自折叠/展开） */
  private syncLayout(): void {
    this.attachScroll()
  }
}
