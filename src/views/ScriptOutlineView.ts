/**
 * 大纲侧栏视图 — 消费 OutlineStore 的 OutlineNode 树
 *
 * 功能：
 *   - 可折叠节点树（heading 深度层级 + 最近 heading 下的 marker/正文）
 *   - 点击节点跳转 MarkdownView 对应行
 *   - HTML5 拖拽 reparent（拖到某节点 → 挂到其子；拖到 sibling 间 → 插到该位置）
 *   - 右键菜单：折叠/展开/在下方添加 marker 块
 *   - 幕布风格 UI：圆点展开收起、缩进连接线、层级徽章
 */

import {
  ItemView,
  MarkdownView,
  Notice,
  WorkspaceLeaf,
} from "obsidian"
import type { App } from "obsidian"
import type { OutlineStore } from "./OutlineStore"
import { flattenByLine, type OutlineNode } from "../core/outline"
import { splitAnnotations } from "../omm/core/annotations"
import { scriptMarkerOf } from "../omm/core/scriptMarker"
import {
  MODEVOL_LABELS,
  SCRIPT_LABELS,
} from "../script-types"

export const OUTLINE_VIEW_TYPE = "lenscript-outline"

export class ScriptOutlineView extends ItemView {
  private store: OutlineStore
  private unsub?: () => void
  private activeFile = ""
  private activeLine = -1
  private activeWatchers: Array<() => void> = []

  constructor(
    leaf: WorkspaceLeaf,
    store: OutlineStore,
    /** 点击某行后回调，用于把导图视图定位到同一位置（由插件注入）。 */
    private readonly onReveal?: (path: string, line: number) => void,
  ) {
    super(leaf)
    this.store = store
  }

  getViewType(): string {
    return OUTLINE_VIEW_TYPE
  }

  getDisplayText(): string {
    return "大纲 · 镜语"
  }

  getIcon(): string {
    return "list-tree"
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("ls-outline-view")
    this.contentEl.empty()

    this.unsub = this.store.onChange(() => this.render())

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) this.openFile(file)
      }),
    )

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const v = leaf?.view
        if (v instanceof MarkdownView && v.file?.path === this.activeFile) {
          this.trackEditorCursor(v)
        }
      }),
    )

    const active = this.app.workspace.getActiveFile()
    if (active) await this.openFile(active)
    else this.showHint("打开一个 Markdown 文件开始创作")
  }

  private showHint(text: string): void {
    this.contentEl.empty()
    this.contentEl.createEl("p", { cls: "ls-hint", text })
  }

  private async openFile(file: any): Promise<void> {
    const path = (file as any).path as string
    if (this.activeFile === path) return
    this.activeFile = path
    const tfile = this.app.vault.getAbstractFileByPath(path) as any
    if (!tfile || tfile.extension !== "md") {
      this.showHint("打开一个 Markdown 文件开始创作")
      return
    }
    await this.store.load(tfile)
    this.render()
  }

  async onClose(): Promise<void> {
    this.unsub?.()
    this.containerEl.removeClass("ls-outline-view")
  }

  private render(): void {
    // 清理编辑器光标 watcher
    this.activeWatchers.forEach((w) => w())
    this.activeWatchers = []

    const state = this.store.state
    const { roots } = state
    this.contentEl.empty()

    if (!this.activeFile) {
      this.showHint("打开一个 Markdown 文件开始创作")
      return
    }
    if (roots.length === 0) {
      this.showHint("此文件还没有可锚定的结构。用 # 写标题，用 #s #d #l 等 marker 写段落。")
      return
    }

    const scroll = this.contentEl.createDiv({ cls: "ls-outline-scroll" })
    this.renderNodes(scroll, roots, 0)

    const status = this.contentEl.createDiv({ cls: "ls-outline-status" })
    const total = flattenByLine(roots).length
    status.setText(`${total} 个节点  ·  v${state.treeVersion}`)

    // 标记当前正在编辑的行
    this.markActiveRow()
    // 开始追踪 MarkdownView 光标
    this.watchActiveEditor()
  }

  private renderNodes(
    parent: HTMLElement,
    nodes: OutlineNode[],
    depth: number,
  ): void {
    const visible = nodes.filter(
      (c) => c.kind !== "frontmatter" && c.kind !== "code",
    )
    visible.forEach((node, i) => {
      const row = parent.createDiv({ cls: "ls-outline-row" })
      row.dataset.id = node.id
      row.dataset.line = String(node.startLine)
      row.draggable = true

      row.style.paddingLeft = `${depth * 14 + 6}px`

      const hasChildren = node.children.some(
        (c) => c.kind !== "frontmatter" && c.kind !== "code",
      )
      if (hasChildren) row.addClass("has-children")
      if (node.collapsed) row.addClass("ls-collapsed")
      if (i === visible.length - 1) row.addClass("is-last-child")

      const caret = row.createSpan({ cls: "ls-caret" })
      if (hasChildren) {
        caret.onclick = (e) => {
          e.stopPropagation()
          this.store.setCollapsed(node.id, !node.collapsed)
        }
      }

      // 标记既可能是独立 marker 行，也可能是 `## #e 同类数` 这种写在标题文字里的
      const leading = scriptMarkerOf(node.text)
      const marker = node.marker ?? leading?.marker
      const badgeText = node.tagLabel ?? (marker
        ? MODEVOL_LABELS[marker as keyof typeof MODEVOL_LABELS] ??
          SCRIPT_LABELS[marker as keyof typeof SCRIPT_LABELS] ??
          marker
        : undefined)
      if (badgeText) {
        const badge = row.createSpan({
          cls: `ls-badge ls-badge-${marker ?? "custom"}`,
        })
        badge.setText(badgeText)
        if (node.tagColor) badge.style.background = node.tagColor
        badge.title = node.tagMarker
          ? `${badgeText}（${node.tagMarker}）`
          : badgeText
      }

      const label = row.createSpan({ cls: "ls-label" })
      if (node.kind === "heading") {
        row.addClass("ls-row-heading")
        if (node.level) row.addClass(`ls-level-${node.level}`)
      }
      // 去掉行尾注解与开头的 #x 标记，只显示标题文字
      const display = splitAnnotations(leading ? leading.rest : node.text).text
      label.setText(display || (node.kind === "heading" ? "(标题)" : "(空)"))
      label.title = display

      row.onclick = () => {
        this.jumpToLine(node.startLine)
        // 同时把开着的导图定位到同一位置并展开
        this.onReveal?.(this.activeFile, node.startLine)
      }

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/lenscript-node-id", node.id)
        e.dataTransfer!.effectAllowed = "move"
        row.addClass("ls-dragging")
      })
      row.addEventListener("dragend", () => row.removeClass("ls-dragging"))

      row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer) return
        e.dataTransfer.dropEffect = "move"
        row.addClass("ls-drop-target")
        e.preventDefault()
      })
      row.addEventListener("dragleave", () => row.removeClass("ls-drop-target"))

      row.addEventListener("drop", (e) => {
        e.preventDefault()
        row.removeClass("ls-drop-target")
        const id = e.dataTransfer?.getData("text/lenscript-node-id")
        if (!id || id === node.id) return
        const ok = this.store.reparent(id, node.id)
        if (!ok) {
          const parentRow = row.parentElement?.closest(".ls-outline-row") as HTMLElement | null
          const parentId = parentRow?.dataset?.id ?? "root"
          this.store.reparent(id, parentId, node.id)
        }
      })

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        this.showContextMenu(node, e.clientX, e.clientY)
      })

      if (hasChildren && !node.collapsed) {
        this.renderNodes(parent, node.children, depth + 1)
      }
    })
  }

  private showContextMenu(node: OutlineNode, x: number, y: number): void {
    const menu = this.containerEl.createDiv({ cls: "ls-context-menu" })
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`

    const open = () => menu.remove()
    document.addEventListener("click", open, { once: true })
    window.addEventListener("scroll", open, { once: true })

    menu.createDiv({ text: node.collapsed ? "展开" : "折叠", cls: "ls-ctx-item" })
      .onclick = () => {
        this.store.setCollapsed(node.id, !node.collapsed)
      }

    menu.createDiv({ text: "添加 #s 场景子节点", cls: "ls-ctx-item" })
      .onclick = () => {
        this.store.addChild(node.id, "paragraph", "新场景", "s")
      }

    menu.createDiv({ text: "删除此节点", cls: "ls-ctx-item ls-danger" })
      .onclick = () => {
        this.store.remove(node.id)
        new Notice("已从大纲移除（Markdown 原文未改动）")
      }
  }

  private markdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (active && active.file?.path === this.activeFile) return active
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === this.activeFile
      ) {
        return leaf.view
      }
    }
    return null
  }

  private jumpToLine(line: number): void {
    const view = this.markdownView()
    if (!view) {
      new Notice("找不到对应的 Markdown 编辑视图")
      return
    }
    const editor = view.editor
    const target = Math.min(line + 1, editor.lineCount())
    const pos = { line: target - 1, ch: 0 }
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true })
    editor.setCursor(pos)
    editor.scrollIntoView({ from: pos, to: pos }, true)
    editor.focus()
    this.markActiveRow()
  }

  // ================= 幕布风：光标联动高亮 =================

  private watchActiveEditor(): void {
    const view = this.markdownView()
    if (!view || !view.editor) return
    this.trackEditorCursor(view)
    // 内容改变时也更新（例如用户直接在编辑器里写新 marker）
    const ed = view.editor as any
    this.activeWatchers.push(
      ed.on?.("change", () => this.markActiveRow()) ?? (() => {}),
    )
    this.markActiveRow()
  }

  private trackEditorCursor(view: MarkdownView): void {
    const editor = view.editor as any
    if (!editor) return
    const onCursor = () => this.markActiveRow()
    editor.on?.("cursor", onCursor)
    // 记录此 watcher 以便 render 时清理
    this.activeWatchers.push(() => {
      try { editor.off?.("cursor", onCursor) } catch {}
    })
    this.markActiveRow()
  }

  /** 根据 MarkdownView 当前光标位置高亮大纲中对应行 */
  private markActiveRow(): void {
    const view = this.markdownView()
    const cursorLine = view?.editor?.getCursor()?.line ?? -1
    if (cursorLine === this.activeLine) return
    this.activeLine = cursorLine

    // 清除旧 active
    for (const el of this.contentEl.querySelectorAll(".ls-outline-row.is-active")) {
      el.removeClass("is-active")
    }

    if (cursorLine < 0) return
    // 找 startLine <= cursorLine 的最深节点
    const rows = this.contentEl.querySelectorAll<HTMLElement>(".ls-outline-row")
    let best: HTMLElement | null = null
    let bestLine = -1
    rows.forEach((r) => {
      const l = Number(r.dataset.line ?? "-1")
      if (l <= cursorLine && l > bestLine) {
        bestLine = l
        best = r
      }
    })
    if (best) {
      (best as HTMLElement).addClass("is-active")
      ;(best as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }
}
