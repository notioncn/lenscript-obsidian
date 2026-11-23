/**
 * 独立 `.nestmind` 视图
 *
 * `.nestmind` 是 Nestboard 兼容的脑图文件（扁平节点表 + parentId 树）。
 * 这里提供一个可直接打开、编辑、保存的无限画布视图：
 *   - 平移 / 缩放 / 适应内容
 *   - 选中节点、双击改文字、添加子/兄弟节点、删除子树、折叠
 *   - 自动保存，外部修改同步
 *
 * 与 Markdown 导图视图（MindmapView）是两条独立的数据源，互不影响。
 */

import {
  FileView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian"
import {
  addMindChild,
  mindChildren,
  mindRoot,
  parseNestMind,
  removeMindNode,
  stringifyNestMind,
  touchNestMind,
  type MindNode,
  type NestMindFile,
} from "../core/format/nestmind"
import { makeId } from "../core/format/nboard"

export const NESTMIND_VIEW_TYPE = "lenscript-nestmind"

const NODE_H = 34
const H_GAP = 56
const V_GAP = 12

interface NodeBox {
  node: MindNode
  x: number
  y: number
  w: number
  h: number
}

interface LayoutResult {
  boxes: NodeBox[]
  width: number
  height: number
  minX: number
  minY: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function widthOf(text: string): number {
  return clamp(72, 240, 24 + Array.from(text || " ").length * 14)
}

function layoutMind(mind: NestMindFile): LayoutResult {
  const root = mindRoot(mind)
  if (!root) return { boxes: [], width: 0, height: 0, minX: 0, minY: 0 }

  const boxes: NodeBox[] = []
  const childrenOf = (node: MindNode) =>
    node.collapsed ? [] : mindChildren(mind, node.id)

  const measure = (node: MindNode): number => {
    const kids = childrenOf(node)
    if (!kids.length) return NODE_H
    return Math.max(
      NODE_H,
      kids.reduce((sum, k) => sum + measure(k), 0) + (kids.length - 1) * V_GAP,
    )
  }

  const place = (node: MindNode, x: number, top: number): void => {
    const h = measure(node)
    const w = widthOf(node.text)
    const y = top + h / 2 - NODE_H / 2
    boxes.push({ node, x, y, w, h: NODE_H })
    const kids = childrenOf(node)
    if (!kids.length) return
    const stackH = kids.reduce((sum, k) => sum + measure(k), 0) + (kids.length - 1) * V_GAP
    let cy = top + (h - stackH) / 2
    for (const kid of kids) {
      place(kid, x + w + H_GAP, cy)
      cy += measure(kid) + V_GAP
    }
  }

  place(root, 0, 0)
  const width = Math.max(...boxes.map((b) => b.x + b.w), 0)
  const height = Math.max(...boxes.map((b) => b.y + b.h), 0)
  return { boxes, width, height, minX: 0, minY: 0 }
}

export class NestMindView extends FileView {
  allowNoFile = false

  getViewType(): string {
    return NESTMIND_VIEW_TYPE
  }

  getDisplayText(): string {
    return `脑图 · ${this.file?.basename ?? "未命名"}`
  }

  getIcon(): string {
    return "git-fork"
  }

  private mind: NestMindFile | null = null
  private selectedId: string | null = null
  private editingId: string | null = null
  private saveTimer: number | null = null
  private lastSaved = ""

  private canvasEl: HTMLElement | null = null
  private worldEl: HTMLElement | null = null
  private layoutResult: LayoutResult = { boxes: [], width: 0, height: 0, minX: 0, minY: 0 }

  private x = 0
  private y = 0
  private zoom = 1

  // 触屏手势：双指缩放 + 长按菜单 + 双击编辑
  private touchPoints = new Map<number, { x: number; y: number }>()
  private pinch: {
    dist: number
    zoom: number
    x: number
    y: number
    cx: number
    cy: number
  } | null = null
  private lastTapId: string | null = null
  private lastTapAt = 0
  private lastTouchMenuAt = 0
  private pinchEndedAt = 0

  async onOpen(): Promise<void> {
    this.containerEl.addClass("ls-nm-view")
    this.contentEl.empty()
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return
        if (!this.file || file.path !== this.file.path) return
        if (this.saveTimer) return
        void this.reloadFromDisk(file)
      }),
    )
    this.registerDomEvent(window, "pointermove", (e) => this.trackTouch(e))
    this.registerDomEvent(window, "pointerup", (e) => this.releaseTouch(e))
    this.registerDomEvent(window, "pointercancel", (e) => this.releaseTouch(e))
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.file = file
    this.contentEl.empty()
    this.mind = null
    this.selectedId = null
    this.editingId = null

    const raw = await this.app.vault.read(file)
    this.lastSaved = raw
    const parsed = parseNestMind(raw)
    if (!parsed.ok) {
      this.showMessage(`无法读取脑图：${parsed.error}`)
      return
    }
    this.mind = parsed.value
    this.applyViewState(parsed.value)
    this.selectedId = parsed.value.rootId
    this.render()
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.flushSave()
    this.mind = null
  }

  async onRename(file: TFile): Promise<void> {
    if (this.mind) {
      this.mind.meta.title = file.basename
      this.scheduleSave()
    }
    this.render()
  }

  async onClose(): Promise<void> {
    await this.flushSave()
  }

  private applyViewState(mind: NestMindFile): void {
    this.x = mind.view?.x ?? 0
    this.y = mind.view?.y ?? 0
    this.zoom = clamp(mind.view?.zoom ?? 1, 0.3, 3)
  }

  private persistViewState(): void {
    if (!this.mind) return
    this.mind.view = {
      ...(this.mind.view ?? { background: "dots" }),
      x: this.x,
      y: this.y,
      zoom: this.zoom,
      background: this.mind.view?.background ?? "dots",
    }
    this.scheduleSave()
  }

  private showMessage(message: string): void {
    this.contentEl.empty()
    this.contentEl.createDiv({ cls: "ls-nm-empty", text: message })
  }

  private render(): void {
    if (!this.mind) return
    this.contentEl.empty()
    this.buildToolbar()
    this.buildCanvas()
  }

  private buildToolbar(): void {
    const bar = this.contentEl.createDiv({ cls: "ls-nm-bar" })
    const title = bar.createDiv({ cls: "ls-nm-title" })
    title.setText(this.file?.basename ?? this.mind?.meta.title ?? "脑图")
    title.title = this.file?.path ?? ""

    const tools = bar.createDiv({ cls: "ls-nm-tools" })
    const button = (label: string, onClick: () => void): void => {
      const btn = tools.createEl("button", { cls: "ls-nm-tool", text: label })
      btn.onclick = onClick
    }
    button("＋子节点", () => this.addChildToSelected())
    button("＋兄弟", () => this.addSiblingToSelected())
    button("编辑文字", () => this.editSelected())
    button("折叠/展开", () => this.toggleSelected())
    button("删除", () => this.deleteSelected())
    button("适应", () => this.fit())
    button("保存", () => void this.flushSave())
  }

  private buildCanvas(): void {
    if (!this.mind) return
    const layout = layoutMind(this.mind)
    this.layoutResult = layout

    const canvas = this.contentEl.createDiv({ cls: "ls-nm-canvas" })
    canvas.tabIndex = 0
    this.canvasEl = canvas

    const world = canvas.createDiv({ cls: "ls-nm-world" })
    this.worldEl = world

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("class", "ls-nm-edges")
    svg.setAttribute("width", String(Math.max(layout.width + 40, 1)))
    svg.setAttribute("height", String(Math.max(layout.height + 40, 1)))
    world.appendChild(svg)

    const positions = new Map(layout.boxes.map((b) => [b.node.id, b]))

    const drawLine = (parent: MindNode, child: MindNode): void => {
      const p = positions.get(parent.id)
      const c = positions.get(child.id)
      if (!p || !c) return
      const x1 = p.x + p.w
      const y1 = p.y + p.h / 2
      const x2 = c.x
      const y2 = c.y + c.h / 2
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      const mid = (x1 + x2) / 2
      path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`)
      path.setAttribute("class", "ls-nm-edge")
      svg.appendChild(path)
    }

    const walk = (node: MindNode): void => {
      if (node.collapsed) return
      for (const child of mindChildren(this.mind!, node.id)) {
        drawLine(node, child)
        walk(child)
      }
    }
    const root = mindRoot(this.mind)
    if (root) walk(root)

    for (const box of layout.boxes) {
      this.buildNode(world, box)
    }

    this.applyTransform()
    this.bindCanvas(canvas)
    window.setTimeout(() => this.fit(false, false), 60)
  }

  private buildNode(world: HTMLElement, box: NodeBox): void {
    const node = box.node
    const el = world.createDiv({ cls: "ls-nm-node" })
    el.dataset.nodeId = node.id
    el.style.left = `${box.x}px`
    el.style.top = `${box.y}px`
    el.style.width = `${box.w}px`
    el.style.height = `${box.h}px`
    if (node.id === this.mind?.rootId) el.addClass("is-root")
    if (node.id === this.selectedId) el.addClass("is-selected")
    if (node.collapsed) el.addClass("is-collapsed")

    const hasChildren = mindChildren(this.mind!, node.id).length > 0
    if (hasChildren) {
      const toggle = el.createSpan({
        cls: "ls-nm-toggle",
        text: node.collapsed ? "▸" : "▾",
      })
      toggle.title = node.collapsed ? "展开" : "折叠"
      toggle.onclick = (e) => {
        e.stopPropagation()
        node.collapsed = !node.collapsed
        touchNestMind(this.mind!)
        this.scheduleSave()
        this.render()
      }
    }

    const text = el.createSpan({ cls: "ls-nm-text" })
    text.setText(node.text || "（空节点）")
    if (!node.text) text.addClass("is-empty")
    if (node.done) text.addClass("is-done")

    if (node.note) {
      const dot = el.createSpan({ cls: "ls-nm-note-dot", text: "✎" })
      dot.title = node.note.slice(0, 200)
    }

    el.onclick = (e) => {
      e.stopPropagation()
      this.selectedId = node.id
      this.render()
      this.canvasEl?.focus()
    }
    el.ondblclick = (e) => {
      e.stopPropagation()
      this.beginEdit(node, el)
    }
    el.oncontextmenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - this.lastTouchMenuAt < 700) return
      this.selectedId = node.id
      this.showNodeMenu(node, { x: e.clientX, y: e.clientY })
    }
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || e.button !== 0) return
      this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.touchPoints.size >= 2) {
        if (this.canvasEl) this.startPinch(this.canvasEl)
        return
      }
      this.watchNodeTouch(node, e)
    })
  }

  private watchNodeTouch(node: MindNode, down: PointerEvent): void {
    let timer: number | null = window.setTimeout(() => {
      timer = null
      this.lastTouchMenuAt = Date.now()
      this.selectedId = node.id
      this.showNodeMenu(node, { x: down.clientX, y: down.clientY })
    }, 520)

    const cleanup = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onEnd)
      window.removeEventListener("pointercancel", onEnd)
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) > 8) cleanup()
    }
    const onEnd = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return
      const longPressed = timer === null
      cleanup()
      if (longPressed || Date.now() - this.pinchEndedAt < 320) {
        this.lastTapId = null
        return
      }
      const now = Date.now()
      if (this.lastTapId === node.id && now - this.lastTapAt < 360) {
        this.lastTapId = null
        const el = this.worldEl?.querySelector<HTMLElement>(
          `[data-node-id="${node.id}"]`,
        )
        if (el) this.beginEdit(node, el)
      } else {
        this.lastTapId = node.id
        this.lastTapAt = now
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onEnd)
    window.addEventListener("pointercancel", onEnd)
  }

  private beginEdit(node: MindNode, el: HTMLElement): void {
    if (this.editingId === node.id) return
    this.editingId = node.id
    const textEl = el.querySelector<HTMLElement>(".ls-nm-text")
    if (!textEl) return

    const input = document.createElement("input")
    input.className = "ls-nm-input"
    input.value = node.text
    textEl.replaceWith(input)
    input.focus()
    input.select()

    let finished = false
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      if (commit) {
        const value = input.value.trim()
        if (value && value !== node.text) {
          node.text = value
          touchNestMind(this.mind!)
          this.scheduleSave()
        }
      }
      this.editingId = null
      this.render()
    }

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        finish(true)
      } else if (e.key === "Escape") {
        e.preventDefault()
        finish(false)
      }
      e.stopPropagation()
    }
    input.onblur = () => finish(true)
  }

  private showNodeMenu(node: MindNode, pos: { x: number; y: number }): void {
    const menu = new Menu()
    menu.addItem((item) =>
      item.setTitle("编辑文字").setIcon("pencil").onClick(() => this.editSelected()),
    )
    menu.addItem((item) =>
      item.setTitle("添加子节点").setIcon("git-branch").onClick(() => this.addChildToSelected()),
    )
    menu.addItem((item) =>
      item.setTitle("添加兄弟节点").setIcon("plus").onClick(() => this.addSiblingToSelected()),
    )
    menu.addItem((item) =>
      item
        .setTitle(node.collapsed ? "展开" : "折叠")
        .setIcon("chevrons-up-down")
        .onClick(() => this.toggleSelected()),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle("删除节点及子树")
        .setIcon("trash")
        .onClick(() => this.deleteSelected()),
    )
    menu.showAtPosition(pos)
  }

  private selectedNode(): MindNode | null {
    if (!this.mind || !this.selectedId) return null
    return this.mind.nodes.find((n) => n.id === this.selectedId) ?? null
  }

  private addChildToSelected(): void {
    if (!this.mind) return
    const node = this.selectedNode() ?? mindRoot(this.mind)
    if (!node) return
    const created = addMindChild(this.mind, node.id, "分支主题")
    this.selectedId = created.id
    this.scheduleSave()
    this.render()
  }

  private addSiblingToSelected(): void {
    if (!this.mind) return
    const node = this.selectedNode()
    if (!node) return
    if (!node.parentId) {
      this.addChildToSelected()
      return
    }
    const parentId = node.parentId
    const order = node.order + 1
    for (const sibling of mindChildren(this.mind, parentId)) {
      if (sibling.order >= order) sibling.order += 1
    }
    const created: MindNode = {
      id: makeId("n"),
      text: "分支主题",
      note: "",
      parentId,
      order,
    }
    this.mind.nodes.push(created)
    touchNestMind(this.mind)
    this.selectedId = created.id
    this.scheduleSave()
    this.render()
  }

  private editSelected(): void {
    const node = this.selectedNode()
    if (!node) return
    const el = this.worldEl?.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)
    if (el) this.beginEdit(node, el)
  }

  private toggleSelected(): void {
    const node = this.selectedNode()
    if (!node || !this.mind) return
    node.collapsed = !node.collapsed
    touchNestMind(this.mind)
    this.scheduleSave()
    this.render()
  }

  private deleteSelected(): void {
    const node = this.selectedNode()
    if (!node || !this.mind) return
    if (node.id === this.mind.rootId) {
      new Notice("中心主题不能删除")
      return
    }
    removeMindNode(this.mind, node.id)
    this.selectedId = node.parentId ?? this.mind.rootId
    this.scheduleSave()
    this.render()
  }

  private applyTransform(): void {
    if (!this.worldEl) return
    this.worldEl.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`
  }

  // ================= 触屏手势 =================

  private trackTouch(e: PointerEvent): void {
    if (!this.touchPoints.has(e.pointerId)) return
    this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pinch) this.updatePinch()
  }

  private releaseTouch(e: PointerEvent): void {
    if (!this.touchPoints.has(e.pointerId)) return
    this.touchPoints.delete(e.pointerId)
    if (this.touchPoints.size < 2) this.endPinch()
  }

  private startPinch(canvas: HTMLElement): void {
    if (this.pinch || this.touchPoints.size < 2) return
    const [a, b] = Array.from(this.touchPoints.values())
    const rect = canvas.getBoundingClientRect()
    this.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.zoom,
      x: this.x,
      y: this.y,
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top,
    }
  }

  private updatePinch(): void {
    if (!this.pinch || this.touchPoints.size < 2) return
    const [a, b] = Array.from(this.touchPoints.values())
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    const p = this.pinch
    const next = clamp(p.zoom * (dist / p.dist), 0.3, 3)
    const wx = (p.cx - p.x) / p.zoom
    const wy = (p.cy - p.y) / p.zoom
    this.zoom = next
    this.x = p.cx - wx * next
    this.y = p.cy - wy * next
    this.applyTransform()
  }

  private endPinch(): void {
    if (!this.pinch) return
    this.pinch = null
    this.pinchEndedAt = Date.now()
    this.persistViewState()
  }

  private bindCanvas(canvas: HTMLElement): void {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") {
        this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.touchPoints.size >= 2) {
          this.startPinch(canvas)
          return
        }
      }
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest(".ls-nm-node")) return
      this.selectedId = null
      this.render()
      this.canvasEl?.focus()
      this.pan(e)
    })

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        const factor = e.deltaY < 0 ? 1.12 : 0.89
        const next = clamp(this.zoom * factor, 0.3, 3)
        this.x = mx - (mx - this.x) * (next / this.zoom)
        this.y = my - (my - this.y) * (next / this.zoom)
        this.zoom = next
        this.applyTransform()
        this.persistViewState()
      },
      { passive: false },
    )

    canvas.addEventListener("keydown", (e) => {
      if (this.editingId) return
      const node = this.selectedNode()
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        this.deleteSelected()
      } else if (e.key === "Tab") {
        e.preventDefault()
        this.addChildToSelected()
      } else if (e.key === "Enter") {
        e.preventDefault()
        this.addSiblingToSelected()
      } else if (e.key === "F2") {
        e.preventDefault()
        this.editSelected()
      } else if (e.key === "Escape") {
        this.selectedId = null
        this.render()
      } else if (!node) {
        return
      }
    })
  }

  private pan(down: PointerEvent): void {
    const startX = down.clientX
    const startY = down.clientY
    const ox = this.x
    const oy = this.y
    const move = (e: PointerEvent): void => {
      if (this.pinch || e.pointerId !== down.pointerId) return
      this.x = ox + (e.clientX - startX)
      this.y = oy + (e.clientY - startY)
      this.applyTransform()
    }
    const up = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      this.persistViewState()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  private fit(withNotice = true, persist = true): void {
    const canvas = this.canvasEl
    if (!canvas || !this.layoutResult.boxes.length) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 20 || rect.height < 20) return
    const pad = 48
    const layout = this.layoutResult
    const scale = clamp(
      Math.min(
        (rect.width - pad * 2) / Math.max(layout.width, 1),
        (rect.height - pad * 2) / Math.max(layout.height, 1),
      ),
      0.35,
      1.4,
    )
    this.zoom = scale
    this.x = (rect.width - layout.width * scale) / 2 - layout.minX * scale
    this.y = (rect.height - layout.height * scale) / 2 - layout.minY * scale
    this.applyTransform()
    if (persist) this.persistViewState()
    if (withNotice) new Notice("已适应内容")
  }

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, 500)
  }

  private async flushSave(): Promise<void> {
    if (!this.mind || !this.file) return
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const raw = stringifyNestMind(this.mind)
    if (raw === this.lastSaved) return
    try {
      await this.app.vault.modify(this.file, raw)
      this.lastSaved = raw
    } catch (e) {
      new Notice(`保存脑图失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async reloadFromDisk(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file)
      if (raw === this.lastSaved) return
      const parsed = parseNestMind(raw)
      if (!parsed.ok) return
      this.mind = parsed.value
      this.lastSaved = raw
      this.applyViewState(parsed.value)
      this.selectedId = parsed.value.rootId
      this.render()
    } catch {
      // 外部读取失败时保持当前视图
    }
  }
}
