/**
 * 无限画布视图 —— 读取/编辑 `.nboard`（Nestboard 兼容）
 *
 * 第一阶段能力：
 *   - 无限画布：平移 / 滚轮缩放 / 适应内容
 *   - 渲染卡片：note / noteRef / image / file / link / boardRef / mindRef / mind / pdf / canvas / todo
 *   - 新建便签、双击编辑便签、拖动卡片、拖动右下角改尺寸、Delete 删除
 *   - 渲染分栏、连线、编组（只读）
 *   - 嵌套无限画布：点 boardRef 直接打开目标 `.nboard`
 *
 * 未识别的卡片/字段一律原样保留，保存时不会丢数据。
 */

import {
  App,
  FileView,
  FuzzySuggestModal,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian"
import {
  cardNumber,
  cardText,
  createBoardRefCard,
  createFileCard,
  createImageCard,
  createLinkCard,
  createNoteCard,
  createNoteRefCard,
  findCard,
  makeId,
  nextZ,
  parseNBoard,
  removeCard,
  stringifyNBoard,
  touchNBoard,
  type BoardCard,
  type BoardColumn,
  type NBoardFile,
  type BoardEdge,
} from "../core/format/nboard"
import {
  addMindChild,
  createNestMind,
  mindChildren,
  mindNodeById,
  mindRoot,
  parseNestMind,
  removeMindNode,
  stringifyNestMind,
  touchNestMind,
  type MindNode,
  type NestMindFile,
} from "../core/format/nestmind"

export const BOARD_VIEW_TYPE = "lenscript-board"

type CardSide = NonNullable<BoardEdge["from"]["side"]>
type BoardPoint = { x: number; y: number }

const CARD_SIDES: CardSide[] = ["top", "right", "bottom", "left"]

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export class LensBoardView extends FileView {
  allowNoFile = false

  private board: NBoardFile | null = null
  private canvasEl: HTMLElement | null = null
  private worldEl: HTMLElement | null = null
  private edgeLayer: SVGSVGElement | null = null
  private selectedId: string | null = null
  private selectedIds = new Set<string>()
  private undoStack: string[] = []
  private redoStack: string[] = []
  private connectFrom: string | null = null
  private edgeDraft: {
    fromId: string
    fromSide: CardSide
    toSide: CardSide | null
    pointerId: number
    path: SVGPathElement
  } | null = null
  private edgeTargetId: string | null = null
  private presenting: string[] | null = null
  private presentIndex = 0
  private presentHud: HTMLElement | null = null
  private saveTimer: number | null = null
  private pendingRevision = false
  private editingCardId: string | null = null
  private suppressClick = false
  private dropOutEl: HTMLElement | null = null
  // 触屏手势：双指缩放 + 长按菜单 + 双击进入
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

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
    this.navigation = false
  }

  getViewType(): string {
    return BOARD_VIEW_TYPE
  }

  getIcon(): string {
    return "layout-dashboard"
  }

  getDisplayText(): string {
    return this.board?.meta.title || this.file?.basename || "无限画布"
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "nboard"
  }

  debugInfo(): Record<string, unknown> {
    const canvasRect = this.canvasEl?.getBoundingClientRect()
    const first = this.worldEl?.querySelector<HTMLElement>(".ls-board-card")
    const firstRect = first?.getBoundingClientRect()
    return {
      file: this.file?.path ?? null,
      cards: this.board?.cards.length ?? 0,
      view: this.board?.view ?? null,
      canvasSize: canvasRect ? { w: canvasRect.width, h: canvasRect.height } : null,
      worldTransform: this.worldEl?.style.transform ?? null,
      cardElements: this.worldEl?.querySelectorAll(".ls-board-card").length ?? 0,
      firstCard: first
        ? {
            left: first.style.left,
            top: first.style.top,
            width: first.style.width,
            height: first.style.height,
            rect: firstRect
              ? { x: firstRect.x, y: firstRect.y, w: firstRect.width, h: firstRect.height }
              : null,
          }
        : null,
    }
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("ls-board-view")
    this.contentEl.addClass("ls-board-content")
    this.contentEl.empty()
    // 快捷键挂在 document 上：工具栏按钮/菜单关闭后仍能撤销、删除、全选
    this.registerDomEvent(document, "keydown", (e) => this.handleBoardKey(e))
    // 触屏与拖线：指针移出画布后也能正确结束手势
    this.registerDomEvent(window, "pointermove", (e) => {
      this.trackTouch(e)
      this.updateEdgeDraft(e)
    })
    this.registerDomEvent(window, "pointerup", (e) => {
      this.completeEdgeDraft(e)
      this.releaseTouch(e)
    })
    this.registerDomEvent(window, "pointercancel", (e) => {
      this.cancelEdgeDraft(e.pointerId)
      this.releaseTouch(e)
    })
  }

  async onLoadFile(file: TFile): Promise<void> {
    const text = await this.app.vault.read(file)
    const parsed = parseNBoard(text)
    if (!parsed.ok) {
      this.contentEl.empty()
      this.contentEl.createEl("div", {
        cls: "ls-board-error",
        text: `无法打开无限画布：${parsed.error}`,
      })
      this.board = null
      return
    }
    this.board = parsed.value
    this.selectedId = null
    this.render()
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.flushSave()
  }

  async onRename(file: TFile): Promise<void> {
    // 文件路径变了，下一次保存仍写到 this.file，无需额外处理
  }

  async onClose(): Promise<void> {
    this.cancelEdgeDraft()
    await this.flushSave()
  }

  // ================= 保存 =================

  private scheduleSave(revision = true): void {
    if (!this.board) return
    if (revision) {
      touchNBoard(this.board)
      this.pendingRevision = true
    }
    if (this.saveTimer) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flushSave(), 500)
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.board || !this.file) return
    try {
      await this.app.vault.modify(this.file, stringifyNBoard(this.board))
    } catch (e) {
      new Notice(`无限画布保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ================= 只读 / 撤销 =================

  private get readOnly(): boolean {
    return this.board?.settings.readOnly === true
  }

  private pushUndo(): void {
    if (!this.board) return
    this.undoStack.push(JSON.stringify(this.board))
    if (this.undoStack.length > 60) this.undoStack.shift()
    this.redoStack = []
  }

  private undo(): void {
    if (!this.board || !this.undoStack.length) {
      new Notice("没有可撤销的操作")
      return
    }
    const raw = this.undoStack.pop() as string
    this.redoStack.push(JSON.stringify(this.board))
    this.restoreSnapshot(raw)
  }

  private redo(): void {
    if (!this.board || !this.redoStack.length) {
      new Notice("没有可重做的操作")
      return
    }
    const raw = this.redoStack.pop() as string
    this.undoStack.push(JSON.stringify(this.board))
    this.restoreSnapshot(raw)
  }

  private restoreSnapshot(raw: string): void {
    const parsed = parseNBoard(raw)
    if (!parsed.ok) return
    this.board = parsed.value
    this.selectedId = null
    this.selectedIds.clear()
    this.connectFrom = null
    this.render()
    this.scheduleSave()
  }

  // ================= 渲染 =================

  private render(): void {
    if (!this.board) return
    this.contentEl.empty()

    const board = this.board

    // 顶部工具栏
    const bar = this.contentEl.createDiv({ cls: "ls-board-bar" })
    const title = bar.createDiv({ cls: "ls-board-title" })
    title.setText(board.meta.title || this.file?.basename || "无限画布")
    title.title = this.file?.path ?? ""

    const tools = bar.createDiv({ cls: "ls-board-tools" })
    if (this.readOnly) tools.createDiv({ cls: "ls-board-readonly", text: "只读" })

    this.menuButton(tools, "＋ 卡片", (menu) => this.fillCreateMenu(menu))

    this.toolButton(tools, "插入脑图", () => void this.insertMindFileAtCenter())
    this.toolButton(tools, "连线", () => this.toggleConnect())
    this.toolButton(tools, "编组", () => this.groupSelected())
    this.menuButton(tools, "对齐", (menu) => {
      menu.addItem((item) => item.setTitle("左对齐").onClick(() => this.alignSelected("left")))
      menu.addItem((item) => item.setTitle("顶对齐").onClick(() => this.alignSelected("top")))
      menu.addSeparator()
      menu.addItem((item) => item.setTitle("水平等距分布").onClick(() => this.alignSelected("distribute-x")))
      menu.addItem((item) => item.setTitle("垂直等距分布").onClick(() => this.alignSelected("distribute-y")))
    })
    this.toolButton(tools, "搜索", () => this.openSearch())
    this.toolButton(tools, "演示", () => this.startPresentation())
    this.menuButton(tools, "导出", (menu) => {
      menu.addItem((item) => item.setTitle("脑图卡片 → .nestmind").setIcon("save").onClick(() => void this.exportSelectedMind()))
      menu.addItem((item) => item.setTitle("整块无限画布 → PNG").setIcon("image").onClick(() => void this.exportBoardPng()))
    })
    this.toolButton(tools, "↶", () => this.undo())
    this.toolButton(tools, "↷", () => this.redo())
    this.toolButton(tools, "－", () => this.zoomStep(-1))
    this.toolButton(tools, "＋", () => this.zoomStep(1))
    this.toolButton(tools, "适应", () => this.zoomToFit())
    this.menuButton(tools, "⋯", (menu) => {
      menu.addItem((item) => item.setTitle("全选卡片").setIcon("box-select").onClick(() => this.selectAll()))
      menu.addItem((item) => item.setTitle("删除选中").setIcon("trash").onClick(() => this.deleteSelected()))
      menu.addSeparator()
      menu.addItem((item) =>
        item
          .setTitle(this.readOnly ? "退出只读模式" : "切换只读模式")
          .setIcon("lock")
          .onClick(() => this.toggleReadOnly()),
      )
    })
    const count = tools.createDiv({ cls: "ls-board-count" })
    count.setText(
      this.selectedIds.size > 1
        ? `已选 ${this.selectedIds.size} 张 / ${board.cards.length} 张`
        : `${board.cards.length} 张卡片`,
    )

    // 画布
    const canvas = this.contentEl.createDiv({
      cls: `ls-board-canvas is-bg-${board.view.background}`,
    })
    canvas.tabIndex = 0
    this.canvasEl = canvas

    const world = canvas.createDiv({ cls: "ls-board-world" })
    this.worldEl = world

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("class", "ls-board-edges")
    this.edgeLayer = svg
    world.appendChild(svg)

    // 分栏
    for (const col of board.columns) {
      const el = world.createDiv({ cls: "ls-board-column" })
      el.dataset.columnId = col.id
      el.style.left = `${col.x}px`
      el.style.top = `${col.y}px`
      el.style.width = `${col.width}px`
      el.style.height = `${col.height}px`
      el.style.zIndex = String(col.z)
      const label = el.createDiv({ cls: "ls-board-column-title", text: col.title || "分栏" })
      label.ondblclick = (e) => {
        e.stopPropagation()
        this.promptText("重命名分栏", col.title || "分栏", (value) => {
          this.pushUndo()
          col.title = value
          this.scheduleSave()
          this.render()
        })
      }
      el.oncontextmenu = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const menu = new Menu()
        menu.addItem((item) =>
          item.setTitle("重命名").setIcon("pencil").onClick(() =>
            this.promptText("重命名分栏", col.title || "分栏", (value) => {
              this.pushUndo()
              col.title = value
              this.scheduleSave()
              this.render()
            }),
          ),
        )
        menu.addItem((item) =>
          item.setTitle("删除分栏").setIcon("trash").onClick(() => this.removeColumn(col.id)),
        )
        menu.showAtMouseEvent(e)
      }
    }

    // 编组包围盒
    for (const group of board.groups) {
      const members = group.cardIds
        .map((id) => findCard(board, id))
        .filter((c): c is BoardCard => !!c)
      if (!members.length) continue
      const minX = Math.min(...members.map((c) => c.x))
      const minY = Math.min(...members.map((c) => c.y))
      const maxX = Math.max(...members.map((c) => c.x + c.width))
      const maxY = Math.max(...members.map((c) => c.y + c.height))
      const box = world.createDiv({ cls: "ls-board-group" })
      box.dataset.groupId = group.id
      box.style.left = `${minX - 12}px`
      box.style.top = `${minY - 34}px`
      box.style.width = `${maxX - minX + 24}px`
      box.style.height = `${maxY - minY + 46}px`
      const groupLabel = box.createDiv({ cls: "ls-board-group-label", text: group.label || "编组" })
      groupLabel.ondblclick = (e) => {
        e.stopPropagation()
        this.promptText("重命名编组", group.label || "编组", (value) => {
          this.pushUndo()
          group.label = value
          this.scheduleSave()
          this.render()
        })
      }
      box.oncontextmenu = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const menu = new Menu()
        menu.addItem((item) =>
          item.setTitle("重命名").setIcon("pencil").onClick(() =>
            this.promptText("重命名编组", group.label || "编组", (value) => {
              this.pushUndo()
              group.label = value
              this.scheduleSave()
              this.render()
            }),
          ),
        )
        menu.addItem((item) =>
          item.setTitle("解散编组").setIcon("trash").onClick(() => this.removeGroup(group.id)),
        )
        menu.showAtMouseEvent(e)
      }
    }

    // 卡片
    const sorted = [...board.cards].sort((a, b) => a.z - b.z)
    for (const card of sorted) {
      this.renderCard(world, card)
    }

    this.renderEdges()
    this.applyTransform()
    this.bindCanvasEvents(canvas)
  }

  private toolButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const btn = parent.createEl("button", { cls: "ls-board-tool", text: label })
    btn.onclick = (e) => {
      e.stopPropagation()
      onClick()
    }
  }

  private menuButton(
    parent: HTMLElement,
    label: string,
    build: (menu: Menu) => void,
  ): void {
    const btn = parent.createEl("button", { cls: "ls-board-tool", text: label })
    btn.onclick = (e) => {
      e.stopPropagation()
      const menu = new Menu()
      build(menu)
      const rect = btn.getBoundingClientRect()
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 })
    }
  }

  private applySelectionClasses(): void {
    if (!this.worldEl) return
    for (const el of Array.from(this.worldEl.querySelectorAll<HTMLElement>(".ls-board-card"))) {
      el.toggleClass("is-selected", this.selectedIds.has(el.dataset.cardId ?? ""))
    }
    this.contentEl.querySelector<HTMLElement>(".ls-board-count")?.setText(
      this.board
        ? this.selectedIds.size > 1
          ? `已选 ${this.selectedIds.size} 张 / ${this.board.cards.length} 张`
          : `${this.board.cards.length} 张卡片`
        : "",
    )
  }

  private setSelection(ids: string[]): void {
    this.selectedIds = new Set(ids)
    this.selectedId = ids.length ? ids[ids.length - 1] : null
    this.applySelectionClasses()
  }

  private toggleSelection(id: string): void {
    const next = new Set(this.selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    this.setSelection(Array.from(next))
  }

  private renderCard(world: HTMLElement, card: BoardCard): void {
    if (!this.board) return
    const el = world.createDiv({
      cls: `ls-board-card ls-card-type-${card.type}`,
    })
    if (card.id === this.selectedId || this.selectedIds.has(card.id)) el.addClass("is-selected")
    el.dataset.cardId = card.id
    el.style.left = `${card.x}px`
    el.style.top = `${card.y}px`
    el.style.width = `${card.width}px`
    el.style.height = `${card.height}px`
    el.style.zIndex = String(card.z)

    if (card.color && /^[1-6]$/.test(card.color)) {
      el.addClass(`ls-card-color-${card.color}`)
    }

    const head = el.createDiv({ cls: "ls-card-head" })
    const titleEl = head.createDiv({ cls: "ls-card-title" })
    titleEl.setText(this.cardTitle(card))
    if (!card.showTitle && card.type !== "noteRef") titleEl.addClass("is-hidden")

    const body = el.createDiv({ cls: "ls-card-body" })
    void this.renderCardBody(card, body)

    // 缩放手柄
    const handle = el.createDiv({ cls: "ls-card-resize" })
    this.bindResize(card, handle)

    // 四边连接柄：直接拖到目标卡片，落点所在侧会持久化到连线端点
    if (!this.readOnly) {
      for (const side of CARD_SIDES) {
        const connector = el.createDiv({
          cls: `ls-board-connect-handle ls-board-connect-${side}`,
        })
        connector.title = "拖动连接到另一张卡片"
        connector.setAttribute("aria-label", `从卡片${side}侧拖出连线`)
        connector.addEventListener("pointerdown", (e) => this.beginEdgeDraft(e, card.id, side))
        connector.addEventListener("click", (e) => e.stopPropagation())
        connector.addEventListener("dblclick", (e) => e.stopPropagation())
      }
    }

    // 拖动 / 触屏长按
    el.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement
      if (target.closest(".ls-card-resize, textarea, input, a, button")) return
      if (e.button !== 0) return
      e.stopPropagation()
      this.suppressClick = false
      this.canvasEl?.focus()

      if (e.pointerType === "touch") {
        this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.touchPoints.size >= 2) {
          if (this.canvasEl) this.startPinch(this.canvasEl)
          return
        }
      }

      if (this.connectFrom) {
        if (card.id !== this.connectFrom) this.finishConnect(card.id)
        return
      }

      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      if (additive) {
        this.toggleSelection(card.id)
        return
      }
      if (!this.selectedIds.has(card.id)) this.setSelection([card.id])
      if (this.readOnly) {
        if (e.pointerType === "touch") this.watchCardTouch(card, e, body)
        return
      }
      this.bringToFront(card)
      if (e.pointerType === "touch") this.watchCardTouch(card, e, body)
      this.dragCard(card, e)
    })

    // 双击：便签进入编辑，脑图卡片打开节点编辑器，待办打开编辑器，其余卡片打开目标
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation()
      this.activateCard(card, body)
    })

    // 单击只选中，不触发跳转（避免拖动时误开文件）
    el.addEventListener("click", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false
        return
      }
      if (this.editingCardId) return
      if ((e.target as HTMLElement).closest(".ls-card-resize")) return
    })

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (this.readOnly) return
      // 触屏长按已经弹过菜单时，避免系统 contextmenu 再弹一次
      if (Date.now() - this.lastTouchMenuAt < 700) return
      this.setSelection([card.id])
      this.showCardMenu(card, { x: e.clientX, y: e.clientY })
    })
  }

  /** 双击 / 触屏双击的卡片激活逻辑 */
  private activateCard(card: BoardCard, body: HTMLElement): void {
    if (this.readOnly) {
      if (card.type !== "note" && card.type !== "mind") this.openCardTarget(card)
      return
    }
    if (card.type === "note") this.editNote(card, body)
    else if (card.type === "mind" || card.type === "mindRef") void this.editMindCard(card)
    else if (card.type === "todo") this.editTodoCard(card)
    else this.openCardTarget(card)
  }

  private showCardMenu(card: BoardCard, pos: { x: number; y: number }): void {
    if (this.readOnly) return
    const menu = new Menu()
    menu.addItem((item) =>
      item.setTitle("置于顶层").setIcon("layers").onClick(() => {
        this.pushUndo()
        this.bringToFront(card)
        this.scheduleSave()
        this.render()
      }),
    )
    menu.addItem((item) =>
      item.setTitle("删除卡片").setIcon("trash").onClick(() => this.deleteSelected()),
    )
    menu.showAtPosition(pos)
  }

  /** 触屏卡片手势：长按弹菜单，双击进入编辑/打开 */
  private watchCardTouch(card: BoardCard, down: PointerEvent, body: HTMLElement): void {
    let timer: number | null = null
    if (!this.readOnly) {
      timer = window.setTimeout(() => {
        timer = null
        this.suppressClick = true
        this.lastTouchMenuAt = Date.now()
        this.setSelection([card.id])
        this.showCardMenu(card, { x: down.clientX, y: down.clientY })
      }, 520)
    }

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
      const longPressed = timer === null && this.suppressClick
      cleanup()
      if (longPressed || this.suppressClick || Date.now() - this.pinchEndedAt < 320) {
        this.lastTapId = null
        return
      }
      const now = Date.now()
      if (this.lastTapId === card.id && now - this.lastTapAt < 360) {
        this.lastTapId = null
        this.activateCard(card, body)
      } else {
        this.lastTapId = card.id
        this.lastTapAt = now
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onEnd)
    window.addEventListener("pointercancel", onEnd)
  }

  private cardTitle(card: BoardCard): string {
    switch (card.type) {
      case "note":
        return card.title || (card.showTitle ? "便签" : "")
      case "noteRef":
        return card.title || (cardText(card, "path").split("/").pop() ?? "引用")
      case "image":
        return card.title || cardText(card, "caption") || "图片"
      case "file":
        return card.title || (cardText(card, "path").split("/").pop() ?? "文件")
      case "link":
        return card.title || "链接"
      case "boardRef":
        return card.title || (cardText(card, "path").split("/").pop() ?? "嵌套无限画布")
      case "mindRef":
        return card.title || (cardText(card, "path").split("/").pop() ?? "脑图文件")
      case "mind": {
        const mind = card.content.mind as NestMindFile | undefined
        return card.title || mind?.meta?.title || "脑图"
      }
      case "todo":
        return card.title || "待办"
      case "pdf":
        return card.title || "PDF"
      case "canvas":
        return card.title || "Canvas"
      default:
        return card.title || card.type
    }
  }

  private async renderCardBody(card: BoardCard, body: HTMLElement): Promise<void> {
    switch (card.type) {
      case "note": {
        const md = cardText(card, "md")
        if (!md.trim()) {
          body.createDiv({ cls: "ls-card-empty", text: "双击编辑…" })
          return
        }
        await MarkdownRenderer.render(
          this.app,
          md,
          body,
          this.file?.path ?? "",
          this,
        ).catch(() => {
          body.empty()
          body.createDiv({ cls: "ls-card-excerpt", text: md })
        })
        break
      }

      case "noteRef": {
        const path = cardText(card, "path")
        const subpath = cardText(card, "subpath")
        const lines = cardNumber(card, "excerptLines", 6)
        let text = ""
        try {
          text = await this.readExcerpt(path, subpath, lines)
        } catch {
          text = "（读取失败）"
        }
        body.createDiv({ cls: "ls-card-excerpt", text: text || "（空笔记）" })
        break
      }

      case "image": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          const url = this.app.vault.adapter.getResourcePath(path)
          const img = body.createEl("img", { cls: "ls-card-image" })
          img.src = url
          img.alt = cardText(card, "caption")
        } else {
          body.createDiv({ cls: "ls-card-empty", text: `图片不存在：${path}` })
        }
        break
      }

      case "file": {
        const path = cardText(card, "path")
        body.createDiv({
          cls: "ls-card-file-name",
          text: path.split("/").pop() ?? path,
        })
        break
      }

      case "pdf": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          const embed = body.createEl("embed", { cls: "ls-card-pdf" })
          embed.setAttribute("src", this.app.vault.adapter.getResourcePath(path))
          embed.setAttribute("type", "application/pdf")
        } else {
          body.createDiv({ cls: "ls-card-empty", text: `PDF 不存在：${path}` })
        }
        break
      }

      case "video": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          const video = body.createEl("video", { cls: "ls-card-video" })
          video.controls = true
          video.src = this.app.vault.adapter.getResourcePath(path)
        } else {
          body.createDiv({ cls: "ls-card-empty", text: `视频不存在：${path}` })
        }
        break
      }

      case "audio": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          const audio = body.createEl("audio", { cls: "ls-card-audio" })
          audio.controls = true
          audio.src = this.app.vault.adapter.getResourcePath(path)
        } else {
          body.createDiv({ cls: "ls-card-empty", text: `音频不存在：${path}` })
        }
        break
      }

      case "canvas": {
        const path = cardText(card, "path")
        body.createDiv({ cls: "ls-card-file-name", text: path.split("/").pop() ?? path })
        body.createDiv({ cls: "ls-card-empty", text: "Canvas 画布 · 双击打开" })
        break
      }

      case "link": {
        const url = cardText(card, "url")
        const desc = cardText(card, "description")
        body.createDiv({ cls: "ls-card-link-domain", text: domainOf(url) })
        if (desc) body.createDiv({ cls: "ls-card-link-desc", text: desc })
        body.createDiv({ cls: "ls-card-link-url", text: url })
        break
      }

      case "boardRef": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          const raw = await this.app.vault.read(target)
          const parsed = parseNBoard(raw)
          if (parsed.ok) {
            body.createDiv({
              cls: "ls-card-board-title",
              text: parsed.value.meta.title || target.basename,
            })
            body.createDiv({
              cls: "ls-card-board-count",
              text: `${parsed.value.cards.length} 张卡片`,
            })
          } else {
            body.createDiv({ cls: "ls-card-empty", text: "无限画布无法读取" })
          }
        } else {
          body.createDiv({ cls: "ls-card-empty", text: `无限画布不存在：${path}` })
        }
        break
      }

      case "mindRef": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (!(target instanceof TFile)) {
          body.createDiv({ cls: "ls-card-empty", text: `脑图文件不存在：${path}` })
          return
        }
        try {
          const raw = await this.app.vault.read(target)
          const parsed = parseNestMind(raw)
          if (parsed.ok) this.renderMindSvg(parsed.value, body)
          else body.createDiv({ cls: "ls-card-empty", text: "脑图文件无法读取" })
        } catch {
          body.createDiv({ cls: "ls-card-empty", text: "脑图文件读取失败" })
        }
        break
      }

      case "mind": {
        const mind = card.content.mind as NestMindFile | undefined
        if (mind && Array.isArray(mind.nodes) && typeof mind.rootId === "string") {
          this.renderMindSvg(mind, body)
        } else {
          body.createDiv({ cls: "ls-card-empty", text: "空脑图卡片" })
        }
        break
      }

      case "todo": {
        const items = card.content.items
        if (Array.isArray(items)) {
          for (const item of items.slice(0, 8)) {
            const row = body.createDiv({ cls: "ls-card-todo" })
            const done = !!(item as any)?.done
            row.createSpan({ text: done ? "☑ " : "☐ " })
            row.createSpan({ text: String((item as any)?.text ?? "") })
          }
        } else {
          body.createDiv({ cls: "ls-card-empty", text: "空待办" })
        }
        break
      }

      default: {
        body.createDiv({ cls: "ls-card-empty", text: `卡片类型：${card.type}` })
      }
    }
  }

  private async readExcerpt(
    path: string,
    subpath: string,
    lines: number,
  ): Promise<string> {
    if (!path) return ""
    const target = this.app.vault.getAbstractFileByPath(path)
    if (!(target instanceof TFile)) return `（找不到 ${path}）`
    const md = await this.app.vault.read(target)
    const all = md.replace(/\r\n?/g, "\n").split("\n")

    let start = 0
    if (subpath) {
      const raw = subpath.replace(/^#/, "")
      if (raw.startsWith("^")) {
        const id = raw.slice(1)
        const at = all.findIndex((l) => new RegExp(`\\^${id}\\s*$`).test(l))
        if (at >= 0) start = at
      } else {
        const wanted = raw.toLowerCase()
        const at = all.findIndex((l) => {
          const m = /^(#{1,6})[ \t]+(.*)$/.exec(l)
          return !!m && m[2].toLowerCase() === wanted
        })
        if (at >= 0) start = at
      }
    }

    return all
      .slice(start, start + Math.max(1, lines))
      .join("\n")
      .trim()
  }

  // ================= 脑图卡片 =================

  private viewportCenter(): { x: number; y: number } {
    if (!this.canvasEl || !this.board) return { x: 0, y: 0 }
    const rect = this.canvasEl.getBoundingClientRect()
    const v = this.board.view
    return {
      x: (rect.width / 2 - v.x) / v.zoom,
      y: (rect.height / 2 - v.y) / v.zoom,
    }
  }

  /** 工具栏 / 空白右键「新建脑图」：插入一张内嵌脑图卡片 */
  newEmbeddedMindAtCenter(at?: BoardPoint): void {
    if (!this.board || this.readOnly) return
    const { x, y } = at ?? this.viewportCenter()
    const mind = createNestMind("脑图卡片", "中心主题")
    const card: BoardCard = {
      id: makeId("c"),
      type: "mind",
      x: x - 260,
      y: y - 180,
      width: 520,
      height: 360,
      z: nextZ(this.board),
      columnId: null,
      order: 0,
      color: "1",
      accent: null,
      locked: false,
      showTitle: true,
      title: mind.meta.title,
      presentStep: null,
      content: { mind },
    }
    this.pushUndo()
    this.board.cards.push(card)
    this.setSelection([card.id])
    this.scheduleSave()
    this.render()
    void this.editMindCard(card)
  }

  /** 工具栏 / 空白右键「插入脑图」：选择一份 .nestmind 作为引用卡 */
  async insertMindFileAtCenter(at?: BoardPoint): Promise<void> {
    if (!this.board || this.readOnly) return
    const file = await new NestMindPickerModal(this.app).pick()
    if (!file || !this.board) return
    const { x, y } = at ?? this.viewportCenter()
    const card: BoardCard = {
      id: makeId("c"),
      type: "mindRef",
      x: x - 240,
      y: y - 170,
      width: 480,
      height: 340,
      z: nextZ(this.board),
      columnId: null,
      order: 0,
      color: "1",
      accent: null,
      locked: false,
      showTitle: true,
      title: file.basename,
      presentStep: null,
      content: { path: file.path, showSize: true },
    }
    this.pushUndo()
    this.board.cards.push(card)
    this.setSelection([card.id])
    this.scheduleSave()
    this.render()
  }

  /** 把选中的脑图卡片导出成同目录的 .nestmind 文件 */
  async exportSelectedMind(): Promise<void> {
    if (!this.board) return
    const card = this.selectedId ? findCard(this.board, this.selectedId) : null
    if (!card) {
      new Notice("请先选中一张脑图卡片")
      return
    }
    let mind: NestMindFile | null = null
    if (card.type === "mind") {
      mind = card.content.mind as NestMindFile
    } else if (card.type === "mindRef") {
      const path = cardText(card, "path")
      const target = this.app.vault.getAbstractFileByPath(path)
      if (target instanceof TFile) {
        const parsed = parseNestMind(await this.app.vault.read(target))
        if (parsed.ok) mind = parsed.value
      }
    }
    if (!mind) {
      new Notice("选中的不是可导出的脑图卡片")
      return
    }

    const folder = this.file?.parent?.path && this.file.parent.path !== "/"
      ? `${this.file.parent.path}/`
      : ""
    const base = (card.title || mind.meta.title || "脑图").replace(/[\\/:*?"<>|]/g, "-")
    let path = `${folder}${base}.nestmind`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) {
      n++
      path = `${folder}${base} ${n}.nestmind`
    }
    try {
      await this.app.vault.create(path, stringifyNestMind(mind))
      new Notice(`已导出脑图：${path}`)
    } catch (e) {
      new Notice(`导出脑图失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async editMindCard(card: BoardCard): Promise<void> {    let mind: NestMindFile | null = null
    let file: TFile | null = null
    if (card.type === "mind") {
      mind = card.content.mind as NestMindFile
    } else {
      const path = cardText(card, "path")
      const target = this.app.vault.getAbstractFileByPath(path)
      if (target instanceof TFile) {
        file = target
        const raw = await this.app.vault.read(target)
        const parsed = parseNestMind(raw)
        if (parsed.ok) mind = parsed.value
      }
    }
    if (!mind) {
      new Notice("脑图数据无法读取")
      return
    }
    const modal = new MindCardEditorModal(this.app, mind, async (updated) => {
      if (card.type === "mind") {
        card.content.mind = updated
        this.scheduleSave()
        this.render()
      } else if (file) {
        try {
          await this.app.vault.modify(file, stringifyNestMind(updated))
          new Notice(`已保存脑图：${file.path}`)
          this.render()
        } catch (e) {
          new Notice(`保存脑图失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    })
    modal.open()
  }

  /** 卡片内渲染脑图树（轻量 SVG，不启动完整编辑器） */
  private renderMindSvg(mind: NestMindFile, body: HTMLElement): void {
    const root = mindRoot(mind)
    if (!root) {
      body.createDiv({ cls: "ls-card-empty", text: "脑图没有根节点" })
      return
    }

    const NODE_H = 30
    const H_GAP = 44
    const V_GAP = 10
    const positions = new Map<string, { x: number; y: number; w: number; h: number; node: MindNode }>()
    let maxX = 0

    const widthOf = (text: string) =>
      Math.max(56, Math.min(190, 20 + Array.from(text).length * 12))

    const childrenOf = (node: MindNode) =>
      node.collapsed ? [] : mindChildren(mind, node.id)

    const measure = (node: MindNode): number => {
      const kids = childrenOf(node)
      if (!kids.length) return NODE_H
      const total = kids.reduce((sum, k) => sum + measure(k), 0)
      return Math.max(NODE_H, total + (kids.length - 1) * V_GAP)
    }

    const place = (node: MindNode, x: number, top: number): void => {
      const h = measure(node)
      const w = widthOf(node.text || " ")
      const y = top + h / 2 - NODE_H / 2
      positions.set(node.id, { x, y, w, h: NODE_H, node })
      maxX = Math.max(maxX, x + w)
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
    const totalH = measure(root)

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("class", "ls-card-mind-svg")
    svg.setAttribute("viewBox", `-10 -10 ${maxX + 20} ${totalH + 20}`)
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet")

    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g")
    const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g")
    svg.appendChild(edgeLayer)
    svg.appendChild(nodeLayer)

    const drawEdges = (node: MindNode) => {
      const p = positions.get(node.id)
      if (!p) return
      for (const kid of childrenOf(node)) {
        const c = positions.get(kid.id)
        if (c) {
          const x1 = p.x + p.w
          const y1 = p.y + NODE_H / 2
          const x2 = c.x
          const y2 = c.y + NODE_H / 2
          const mid = (x1 + x2) / 2
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
          path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`)
          path.setAttribute("fill", "none")
          path.setAttribute("stroke", "var(--text-faint)")
          path.setAttribute("stroke-width", "1.2")
          edgeLayer.appendChild(path)
        }
        drawEdges(kid)
      }
    }
    drawEdges(root)

    for (const { node, x, y, w } of positions.values()) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g")
      g.setAttribute("transform", `translate(${x}, ${y})`)
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
      rect.setAttribute("width", String(w))
      rect.setAttribute("height", String(NODE_H))
      rect.setAttribute("rx", "7")
      rect.setAttribute("ry", "7")
      const isRoot = node.id === root.id
      rect.setAttribute("fill", isRoot ? "#3f51b5" : "var(--background-modifier-hover)")
      rect.setAttribute("stroke", "var(--background-modifier-border)")
      rect.setAttribute("stroke-width", "1")
      g.appendChild(rect)
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text")
      text.setAttribute("x", "10")
      text.setAttribute("y", String(NODE_H / 2 + 4))
      text.setAttribute("font-size", "11")
      text.setAttribute("fill", isRoot ? "#ffffff" : "var(--text-normal)")
      const label = node.text || "未命名"
      text.textContent = label.length > 16 ? `${label.slice(0, 15)}…` : label
      g.appendChild(text)
      nodeLayer.appendChild(g)
    }

    body.appendChild(svg)
  }

  // ================= 打开目标 =================

  private openCardTarget(card: BoardCard): void {
    if (!this.board) return
    switch (card.type) {
      case "noteRef": {
        const path = cardText(card, "path")
        const subpath = cardText(card, "subpath")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (!(target instanceof TFile)) {
          new Notice(`找不到笔记：${path}`)
          return
        }
        const link = subpath
          ? `${path}#${subpath.replace(/^#/, "")}`
          : path
        void this.app.workspace.openLinkText(link, this.file?.path ?? "", false)
        break
      }
      case "boardRef": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (!(target instanceof TFile)) {
          new Notice(`找不到无限画布：${path}`)
          return
        }
        void this.app.workspace.getLeaf(false).openFile(target)
        break
      }
      case "link": {
        const url = cardText(card, "url")
        if (url) window.open(url, "_blank")
        break
      }
      case "image":
      case "file":
      case "pdf":
      case "canvas":
      case "video":
      case "audio": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) {
          void this.app.workspace.getLeaf(false).openFile(target)
        }
        break
      }
      case "mindRef": {
        const path = cardText(card, "path")
        const target = this.app.vault.getAbstractFileByPath(path)
        if (target instanceof TFile) void this.app.workspace.getLeaf(false).openFile(target)
        else new Notice(`找不到脑图文件：${path}`)
        break
      }
      case "mind":
        new Notice("内嵌脑图：双击卡片打开节点编辑器")
        break
    }
  }

  // ================= 交互 =================

  private selectCard(id: string | null): void {
    this.setSelection(id ? [id] : [])
  }

  private bringToFront(card: BoardCard): void {
    if (!this.board) return
    if (card.z >= nextZ(this.board) - 1) return
    card.z = nextZ(this.board)
    if (this.worldEl) {
      const el = this.worldEl.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`)
      if (el) el.style.zIndex = String(card.z)
    }
    this.scheduleSave(false)
  }

  private dragCard(card: BoardCard, down: PointerEvent): void {
    if (!this.board) return
    const moving =
      this.selectedIds.has(card.id) && this.selectedIds.size > 1
        ? this.board.cards.filter((c) => this.selectedIds.has(c.id))
        : [card]
    const starts = moving.map((c) => ({ card: c, x: c.x, y: c.y, columnId: c.columnId ?? null }))
    const startX = down.clientX
    const startY = down.clientY
    const zoom = this.board.view.zoom || 1
    const els = new Map(
      moving.map((c) => [
        c.id,
        this.worldEl?.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`) ?? null,
      ]),
    )
    els.forEach((el) => el?.addClass("is-dragging"))

    let moved = false
    let pushed = false

    const move = (e: PointerEvent) => {
      if (this.pinch) return
      const dx = (e.clientX - startX) / zoom
      const dy = (e.clientY - startY) / zoom
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true
        this.suppressClick = true
        if (!pushed) {
          this.pushUndo()
          pushed = true
        }
      }
      if (!moved) return
      for (const s of starts) {
        s.card.x = s.x + dx
        s.card.y = s.y + dy
        const el = els.get(s.card.id)
        if (el) {
          el.style.left = `${s.card.x}px`
          el.style.top = `${s.card.y}px`
        }
      }
      this.renderEdges()
      this.updateDropOutTarget(card, e.clientX, e.clientY)
    }

    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      els.forEach((el) => el?.removeClass("is-dragging"))
      this.highlightDropOut(null)

      const singleMind = moving.length === 1 && card.type === "mind"
      const target = singleMind ? this.dropTargetOf(card, e.clientX, e.clientY) : null
      if (target) {
        // 拖出导出：卡片退回原位，内容写成 .nestmind 文件
        for (const s of starts) {
          s.card.x = s.x
          s.card.y = s.y
          const el = els.get(s.card.id)
          if (el) {
            el.style.left = `${s.card.x}px`
            el.style.top = `${s.card.y}px`
          }
        }
        this.renderEdges()
        void this.exportMindCardToFolder(card, target)
        return
      }

      if (moved) {
        if (this.board?.settings.snapToGrid) {
          const g = Math.max(2, this.board.settings.gridSize || 16)
          for (const s of starts) {
            s.card.x = Math.round(s.card.x / g) * g
            s.card.y = Math.round(s.card.y / g) * g
          }
        }
        this.assignCardsToColumns(moving)
        this.scheduleSave()
        this.render()
      } else {
        this.scheduleSave(false)
      }
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  private columnAt(card: BoardCard): BoardColumn | null {
    if (!this.board) return null
    const cx = card.x + card.width / 2
    const cy = card.y + card.height / 2
    for (const col of this.board.columns) {
      if (cx >= col.x && cx <= col.x + col.width && cy >= col.y && cy <= col.y + col.height) {
        return col
      }
    }
    return null
  }

  private assignCardsToColumns(cards: BoardCard[]): void {
    if (!this.board) return
    for (const card of cards) {
      const col = this.columnAt(card)
      const nextId = col?.id ?? null
      if ((card.columnId ?? null) !== nextId) {
        card.columnId = nextId
        if (col) {
          const orders = this.board.cards
            .filter((c) => c.columnId === col.id && c.id !== card.id)
            .map((c) => c.order ?? 0)
          card.order = orders.length ? Math.max(...orders) + 1 : 0
        }
      }
    }
    for (const col of this.board.columns) this.layoutColumn(col)
  }

  private layoutColumn(col: BoardColumn): void {
    if (!this.board) return
    const members = this.board.cards
      .filter((c) => c.columnId === col.id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    let top = col.y + 46
    for (const member of members) {
      member.x = col.x + 14
      member.width = Math.max(120, col.width - 28)
      member.y = top
      top += member.height + 10
    }
  }

  /** 文件浏览器条目（带 data-path）→ 落点文件夹；拖出画布外则落到无限画布同目录 */
  private dropTargetOf(card: BoardCard, clientX: number, clientY: number): string | null {
    if (card.type !== "mind") return null
    const hit = document.elementFromPoint(clientX, clientY)?.closest("[data-path]")
    if (hit) {
      const path = hit.getAttribute("data-path") ?? ""
      const target = this.app.vault.getAbstractFileByPath(path)
      if (target instanceof TFolder) return path
      if (target instanceof TFile) return target.parent?.path ?? ""
      return null
    }
    // 拖出无限画布内容区（但不是落在文件浏览器条目上）→ 生成到无限画布所在目录
    const rect = this.contentEl.getBoundingClientRect()
    const outside =
      clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom
    if (!outside) return null
    return this.file?.parent?.path ?? ""
  }

  private updateDropOutTarget(card: BoardCard, clientX: number, clientY: number): void {
    if (card.type !== "mind") {
      this.highlightDropOut(null)
      return
    }
    const hit = document.elementFromPoint(clientX, clientY)?.closest("[data-path]")
    const target = this.dropTargetOf(card, clientX, clientY)
    this.highlightDropOut(target !== null ? hit ?? null : null)
  }

  private highlightDropOut(el: Element | null): void {
    const next = el instanceof HTMLElement ? el : null
    if (this.dropOutEl === next) return
    this.dropOutEl?.removeClass("ls-drop-out-target")
    this.dropOutEl = next
    next?.addClass("ls-drop-out-target")
  }

  /** 把脑图卡片写成 `.nestmind` 文件，并把卡片转成文件引用 */
  private async exportMindCardToFolder(card: BoardCard, folder: string): Promise<void> {
    const mind = card.content.mind as NestMindFile | undefined
    if (!mind || !Array.isArray(mind.nodes)) {
      new Notice("这张卡片没有可导出的脑图内容")
      return
    }
    const base = (card.title || mind.meta.title || "脑图").replace(/[\\/:*?"<>|]/g, "-")
    let path = folder ? `${folder}/${base}.nestmind` : `${base}.nestmind`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) {
      n++
      path = folder ? `${folder}/${base} ${n}.nestmind` : `${base} ${n}.nestmind`
    }
    try {
      touchNestMind(mind)
      const raw = stringifyNestMind(mind)
      await this.app.vault.create(path, raw)
      card.type = "mindRef"
      card.content = { path, showSize: true }
      card.title = path.split("/").pop()?.replace(/\.nestmind$/, "") ?? base
      this.scheduleSave()
      this.render()
      new Notice(`已生成脑图文件：${path}`)
    } catch (e) {
      new Notice(`导出脑图失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private bindResize(card: BoardCard, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation()
      e.preventDefault()
      if (this.readOnly) return
      const startX = e.clientX
      const startY = e.clientY
      const ow = card.width
      const oh = card.height
      const el = handle.parentElement
      let pushed = false
      const move = (ev: PointerEvent) => {
        if (!pushed) {
          this.pushUndo()
          pushed = true
        }
        card.width = Math.max(120, ow + (ev.clientX - startX))
        card.height = Math.max(80, oh + (ev.clientY - startY))
        if (el) {
          el.style.width = `${card.width}px`
          el.style.height = `${card.height}px`
        }
        this.renderEdges()
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        this.scheduleSave()
        if (pushed) this.render()
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    })
  }

  private bindCanvasEvents(canvas: HTMLElement): void {
    canvas.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement
      const onCard = target.closest(".ls-board-card, .ls-board-column")
      if (e.pointerType === "touch") {
        this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.touchPoints.size >= 2) {
          this.startPinch(canvas)
          return
        }
      }
      if (onCard || e.button !== 0) return
      if (this.presenting) {
        this.nextPresentation()
        return
      }
      if (this.connectFrom) {
        this.connectFrom = null
        new Notice("已取消连线")
        this.render()
        return
      }
      this.canvasEl?.focus()
      if (e.shiftKey) {
        this.startMarquee(e)
        return
      }
      this.setSelection([])
      this.panCanvas(e)
    })

    canvas.addEventListener("wheel", (e) => {
      if (!this.board) return
      if (this.presenting) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const view = this.board.view
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const next = clamp(view.zoom * factor, 0.2, 3)
      const wx = (mx - view.x) / view.zoom
      const wy = (my - view.y) / view.zoom
      view.zoom = next
      view.x = mx - wx * next
      view.y = my - wy * next
      this.applyTransform()
      this.scheduleSave(false)
    }, { passive: false })

    canvas.addEventListener("contextmenu", (e) => {
      if (this.readOnly || this.presenting || !this.board) return
      const target = e.target as Element | null
      if (target?.closest(".ls-board-card, .ls-board-column, .ls-board-edge-hit")) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const view = this.board.view
      const at = {
        x: (e.clientX - rect.left - view.x) / view.zoom,
        y: (e.clientY - rect.top - view.y) / view.zoom,
      }
      const menu = new Menu()
      this.fillCreateMenu(menu, at)
      menu.showAtMouseEvent(e)
    })

    canvas.addEventListener("dblclick", (e) => {
      if (this.readOnly) return
      const target = e.target as HTMLElement
      if (target.closest(".ls-board-card, .ls-board-column")) return
      const rect = canvas.getBoundingClientRect()
      const view = this.board?.view
      if (!view) return
      const wx = (e.clientX - rect.left - view.x) / view.zoom
      const wy = (e.clientY - rect.top - view.y) / view.zoom
      this.newNoteAt(wx, wy)
    })
  }

  private startMarquee(down: PointerEvent): void {
    if (!this.board || !this.canvasEl) return
    const canvas = this.canvasEl
    const rect = canvas.getBoundingClientRect()
    const view = this.board.view
    const sx = down.clientX - rect.left
    const sy = down.clientY - rect.top
    const box = canvas.createDiv({ cls: "ls-board-marquee" })
    const move = (e: PointerEvent) => {
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const x = Math.min(sx, cx)
      const y = Math.min(sy, cy)
      box.style.left = `${x}px`
      box.style.top = `${y}px`
      box.style.width = `${Math.abs(cx - sx)}px`
      box.style.height = `${Math.abs(cy - sy)}px`
      const left = (x - view.x) / view.zoom
      const top = (y - view.y) / view.zoom
      const right = (x + Math.abs(cx - sx) - view.x) / view.zoom
      const bottom = (y + Math.abs(cy - sy) - view.y) / view.zoom
      const ids = this.board!.cards
        .filter(
          (c) =>
            c.x < right &&
            c.x + c.width > left &&
            c.y < bottom &&
            c.y + c.height > top,
        )
        .map((c) => c.id)
      this.setSelection(ids)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      box.remove()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  private panCanvas(down: PointerEvent): void {
    if (!this.board) return
    const view = this.board.view
    const sx = down.clientX
    const sy = down.clientY
    const ox = view.x
    const oy = view.y
    const move = (e: PointerEvent) => {
      // 双指缩放开始后，单指平移立即让位
      if (this.pinch || e.pointerId !== down.pointerId) return
      view.x = ox + (e.clientX - sx)
      view.y = oy + (e.clientY - sy)
      this.applyTransform()
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      this.scheduleSave(false)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
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
    if (!this.board || this.pinch || this.touchPoints.size < 2) return
    const [a, b] = Array.from(this.touchPoints.values())
    const rect = canvas.getBoundingClientRect()
    const view = this.board.view
    this.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: view.zoom,
      x: view.x,
      y: view.y,
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top,
    }
  }

  private updatePinch(): void {
    if (!this.pinch || !this.board || this.touchPoints.size < 2) return
    const [a, b] = Array.from(this.touchPoints.values())
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    const view = this.board.view
    const p = this.pinch
    const next = clamp(p.zoom * (dist / p.dist), 0.2, 3)
    const wx = (p.cx - p.x) / p.zoom
    const wy = (p.cy - p.y) / p.zoom
    view.zoom = next
    view.x = p.cx - wx * next
    view.y = p.cy - wy * next
    this.applyTransform()
  }

  private endPinch(): void {
    if (!this.pinch) return
    this.pinch = null
    this.pinchEndedAt = Date.now()
    this.scheduleSave(false)
  }

  private handleBoardKey(e: KeyboardEvent): void {
    if (this.app.workspace.activeLeaf !== this.leaf) return
    if (document.body.querySelector(".modal-container")) return
    const target = e.target as HTMLElement | null
    if (target?.closest("textarea, input, [contenteditable='true']")) return

    if (this.presenting) {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault()
        this.nextPresentation()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        this.prevPresentation()
      } else if (e.key === "Escape") {
        e.preventDefault()
        this.stopPresentation()
      }
      return
    }

    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault()
      this.selectAll()
      return
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.readOnly) return
      if (!this.selectedIds.size) return
      e.preventDefault()
      this.deleteSelected()
    } else if (e.key === "Escape") {
      this.cancelEdgeDraft()
      this.connectFrom = null
      this.setSelection([])
    }
  }

  private selectAll(): void {
    if (!this.board) return
    this.setSelection(this.board.cards.map((c) => c.id))
  }

  private deleteSelected(): void {
    if (!this.board || this.readOnly) return
    if (!this.selectedIds.size) {
      new Notice("请先选中卡片")
      return
    }
    this.pushUndo()
    for (const id of this.selectedIds) removeCard(this.board, id)
    this.selectedId = null
    this.selectedIds.clear()
    this.scheduleSave()
    this.render()
  }

  // ================= 创建卡片 / 分栏 / 编组 =================

  /** 工具栏与空白右键共用同一套建卡入口；at 固定右键时的世界坐标。 */
  private fillCreateMenu(menu: Menu, at?: BoardPoint): void {
    menu.addItem((item) =>
      item.setTitle("新建 Markdown 便签").setIcon("sticky-note").onClick(() => this.newNoteAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("新建内嵌脑图").setIcon("git-fork").onClick(() => this.newEmbeddedMindAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("插入 .nestmind 脑图").setIcon("file-plus").onClick(() => void this.insertMindFileAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("插入 Markdown 笔记引用").setIcon("file-text").onClick(() => void this.newNoteRefAtCenter(at)),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle("插入图片").setIcon("image").onClick(() => void this.newImageAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("插入文件 / PDF / 媒体 / Canvas").setIcon("file-plus").onClick(() => void this.newFileAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("插入链接").setIcon("link").onClick(() => this.newLinkAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("新建待办").setIcon("check-square").onClick(() => this.newTodoAtCenter(at)),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle("插入已有无限画布（.nboard）").setIcon("layout-grid").onClick(() => void this.newBoardRefAtCenter(at)),
    )
    menu.addItem((item) =>
      item.setTitle("新建分栏").setIcon("columns").onClick(() => this.newColumnAtCenter(at)),
    )
  }

  private addCard(card: BoardCard): void {
    if (!this.board) return
    this.pushUndo()
    this.board.cards.push(card)
    this.setSelection([card.id])
    this.scheduleSave()
    this.render()
  }

  private async newNoteRefAtCenter(at?: BoardPoint): Promise<void> {
    if (!this.board || this.readOnly) return
    const file = await new VaultFilePickerModal(
      this.app,
      (f) => f.extension === "md",
      "选择要引用的 Markdown 笔记",
    ).pick()
    if (!file || !this.board) return
    const { x, y } = at ?? this.viewportCenter()
    this.addCard(
      createNoteRefCard(this.board, file.path, {
        x: x - 140,
        y: y - 90,
        width: 280,
        height: 180,
        title: file.basename,
        excerptLines: 8,
      }),
    )
  }

  private async newBoardRefAtCenter(at?: BoardPoint): Promise<void> {
    if (!this.board || this.readOnly) return
    const file = await new VaultFilePickerModal(
      this.app,
      (f) => f.extension === "nboard" && f.path !== this.file?.path,
      "选择要插入的 .nboard 无限画布",
    ).pick()
    if (!file || !this.board) return
    const { x, y } = at ?? this.viewportCenter()
    this.addCard(
      createBoardRefCard(this.board, file.path, {
        x: x - 60,
        y: y - 60,
        title: file.basename,
      }),
    )
  }

  private async newImageAtCenter(at?: BoardPoint): Promise<void> {
    if (!this.board || this.readOnly) return
    const file = await new VaultFilePickerModal(
      this.app,
      (f) => /^(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i.test(f.extension),
      "选择要插入的图片",
    ).pick()
    if (!file || !this.board) return
    const { x, y } = at ?? this.viewportCenter()
    this.addCard(
      createImageCard(this.board, file.path, {
        x: x - 160,
        y: y - 120,
        title: file.basename,
      }),
    )
  }

  private async newFileAtCenter(at?: BoardPoint): Promise<void> {
    if (!this.board || this.readOnly) return
    const file = await new VaultFilePickerModal(this.app, () => true, "选择文件 / PDF / 媒体 / Canvas").pick()
    if (!file || !this.board) return
    const { x, y } = at ?? this.viewportCenter()
    this.addCard(
      createFileCard(this.board, file.path, {
        x: x - 140,
        y: y - 90,
        width: 280,
        height: 180,
        title: file.basename,
      }),
    )
  }

  private newLinkAtCenter(at?: BoardPoint): void {
    if (!this.board || this.readOnly) return
    new LinkCardModal(this.app, (url, title) => {
      if (!this.board) return
      const { x, y } = at ?? this.viewportCenter()
      this.addCard(
        createLinkCard(this.board, url, title, {
          x: x - 150,
          y: y - 90,
          width: 300,
          height: 180,
        }),
      )
    }).open()
  }

  private newTodoAtCenter(at?: BoardPoint): void {
    if (!this.board || this.readOnly) return
    const { x, y } = at ?? this.viewportCenter()
    const card: BoardCard = {
      id: makeId("c"),
      type: "todo",
      x: x - 160,
      y: y - 100,
      width: 320,
      height: 200,
      z: nextZ(this.board),
      columnId: null,
      order: 0,
      color: "1",
      accent: null,
      locked: false,
      showTitle: true,
      title: "待办",
      presentStep: null,
      content: { items: [{ text: "新待办", done: false }] },
    }
    this.addCard(card)
    this.editTodoCard(card)
  }

  private newColumnAtCenter(at?: BoardPoint): void {
    if (!this.board || this.readOnly) return
    const { x, y } = at ?? this.viewportCenter()
    this.pushUndo()
    this.board.columns.push({
      id: makeId("col"),
      title: "分栏",
      x: x - 160,
      y: y - 260,
      width: 320,
      height: 520,
      collapsed: false,
      color: "#ffffff",
      z: nextZ(this.board),
    })
    this.scheduleSave()
    this.render()
  }

  private groupSelected(): void {
    if (!this.board || this.readOnly) return
    if (this.selectedIds.size === 0) {
      new Notice("请先选中要编组的卡片（Shift / Cmd 多选）")
      return
    }
    this.pushUndo()
    this.board.groups.push({
      id: makeId("g"),
      cardIds: Array.from(this.selectedIds),
      label: "编组",
    })
    this.scheduleSave()
    this.render()
  }

  private removeColumn(id: string): void {
    if (!this.board) return
    this.pushUndo()
    this.board.columns = this.board.columns.filter((c) => c.id !== id)
    for (const card of this.board.cards) {
      if (card.columnId === id) card.columnId = null
    }
    this.scheduleSave()
    this.render()
  }

  private removeGroup(id: string): void {
    if (!this.board) return
    this.pushUndo()
    this.board.groups = this.board.groups.filter((g) => g.id !== id)
    this.scheduleSave()
    this.render()
  }

  private alignSelected(mode: "left" | "top" | "distribute-x" | "distribute-y"): void {
    if (!this.board) return
    const cards = this.board.cards.filter((c) => this.selectedIds.has(c.id))
    if (cards.length < 2) {
      new Notice("请先选中至少两张卡片")
      return
    }
    this.pushUndo()
    if (mode === "left") {
      const x = Math.min(...cards.map((c) => c.x))
      for (const c of cards) c.x = x
    } else if (mode === "top") {
      const y = Math.min(...cards.map((c) => c.y))
      for (const c of cards) c.y = y
    } else if (mode === "distribute-x") {
      const sorted = [...cards].sort((a, b) => a.x - b.x)
      const totalWidth = sorted.reduce((sum, c) => sum + c.width, 0)
      const left = sorted[0].x
      const right = sorted[sorted.length - 1].x + sorted[sorted.length - 1].width
      const gap = (right - left - totalWidth) / Math.max(1, sorted.length - 1)
      let cursor = left
      for (const c of sorted) {
        c.x = cursor
        cursor += c.width + gap
      }
    } else {
      const sorted = [...cards].sort((a, b) => a.y - b.y)
      const totalHeight = sorted.reduce((sum, c) => sum + c.height, 0)
      const top = sorted[0].y
      const bottom = sorted[sorted.length - 1].y + sorted[sorted.length - 1].height
      const gap = (bottom - top - totalHeight) / Math.max(1, sorted.length - 1)
      let cursor = top
      for (const c of sorted) {
        c.y = cursor
        cursor += c.height + gap
      }
    }
    this.scheduleSave()
    this.render()
  }

  toggleReadOnly(): void {
    if (!this.board) return
    this.pushUndo()
    this.board.settings.readOnly = !this.board.settings.readOnly
    this.scheduleSave()
    this.render()
  }

  // ================= 连线 =================

  private beginEdgeDraft(e: PointerEvent, fromId: string, fromSide: CardSide): void {
    if (e.button !== 0 || this.readOnly || !this.board || !this.edgeLayer) return
    const from = this.board.cards.find((c) => c.id === fromId)
    if (!from) return
    e.preventDefault()
    e.stopPropagation()
    this.cancelEdgeDraft()
    this.connectFrom = null

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("class", "ls-board-edge-draft")
    this.edgeLayer.appendChild(path)
    this.edgeDraft = { fromId, fromSide, toSide: null, pointerId: e.pointerId, path }
    this.updateEdgeDraft(e)
  }

  private updateEdgeDraft(e: PointerEvent): void {
    const draft = this.edgeDraft
    if (!draft || draft.pointerId !== e.pointerId || !this.board || !this.canvasEl) return
    const from = this.board.cards.find((c) => c.id === draft.fromId)
    if (!from) {
      this.cancelEdgeDraft()
      return
    }

    const cardEl = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(".ls-board-card") as HTMLElement | null
    const candidateId = cardEl?.dataset.cardId ?? null
    const target = candidateId && candidateId !== draft.fromId
      ? this.board.cards.find((c) => c.id === candidateId) ?? null
      : null
    this.setEdgeTarget(target?.id ?? null)

    const rect = this.canvasEl.getBoundingClientRect()
    const view = this.board.view
    const pointer = {
      x: (e.clientX - rect.left - view.x) / view.zoom,
      y: (e.clientY - rect.top - view.y) / view.zoom,
    }
    const toSide = target ? this.nearestCardSide(target, pointer) : null
    draft.toSide = toSide

    const start = this.edgeAnchor(from, { cardId: from.id, side: draft.fromSide })
    const end = target && toSide
      ? this.edgeAnchor(target, { cardId: target.id, side: toSide })
      : pointer
    draft.path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`)
  }

  private completeEdgeDraft(e: PointerEvent): void {
    if (!this.edgeDraft || this.edgeDraft.pointerId !== e.pointerId) return
    this.updateEdgeDraft(e)
    const draft = this.edgeDraft
    if (!draft) return
    const toId = this.edgeTargetId
    const toSide = draft.toSide
    this.cancelEdgeDraft()
    if (toId && toSide) this.finishConnect(toId, draft.fromSide, toSide, draft.fromId)
  }

  private cancelEdgeDraft(pointerId?: number): void {
    if (pointerId !== undefined && this.edgeDraft?.pointerId !== pointerId) return
    this.edgeDraft?.path.remove()
    this.edgeDraft = null
    this.setEdgeTarget(null)
  }

  private setEdgeTarget(cardId: string | null): void {
    if (this.edgeTargetId === cardId) return
    this.edgeTargetId = cardId
    this.worldEl?.querySelectorAll<HTMLElement>(".ls-board-card").forEach((el) => {
      el.classList.toggle("is-edge-target", el.dataset.cardId === cardId && cardId !== null)
    })
  }

  private nearestCardSide(card: BoardCard, point: BoardPoint): CardSide {
    const distances: Array<[CardSide, number]> = [
      ["left", Math.abs(point.x - card.x)],
      ["right", Math.abs(point.x - card.x - card.width)],
      ["top", Math.abs(point.y - card.y)],
      ["bottom", Math.abs(point.y - card.y - card.height)],
    ]
    return distances.reduce((best, current) => current[1] < best[1] ? current : best)[0]
  }

  private toggleConnect(): void {
    if (!this.board || this.readOnly) return
    if (this.connectFrom) {
      this.connectFrom = null
      this.render()
      return
    }
    if (this.selectedIds.size !== 1 || !this.selectedId) {
      new Notice("请先选中一张卡片作为连线起点")
      return
    }
    this.connectFrom = this.selectedId
    const el = this.worldEl?.querySelector<HTMLElement>(
      `[data-card-id="${this.connectFrom}"]`,
    )
    el?.addClass("is-connect-source")
    new Notice("已选起点，点击另一张卡片完成连线；点空白处取消")
  }

  private finishConnect(
    toId: string,
    fromSide: CardSide | null = null,
    toSide: CardSide | null = null,
    dragFromId?: string,
  ): void {
    if (!this.board || this.readOnly) return
    const fromId = dragFromId ?? this.connectFrom
    if (!fromId) return
    this.connectFrom = null
    if (fromId === toId) return
    const edge: BoardEdge = {
      id: makeId("e"),
      from: { cardId: fromId, side: fromSide },
      to: { cardId: toId, side: toSide },
      fromEnd: "none",
      toEnd: "arrow",
      style: "solid",
      color: "1",
      label: "",
    }
    this.pushUndo()
    this.board.edges.push(edge)
    this.scheduleSave()
    this.render()
    if (dragFromId !== undefined) return
    this.promptText("连线标签（可留空）", "", (value) => {
      edge.label = value.trim()
      this.scheduleSave()
      this.render()
    })
  }

  // ================= 搜索 / 演示 =================

  private focusCard(card: BoardCard): void {
    if (!this.board || !this.canvasEl) return
    const rect = this.canvasEl.getBoundingClientRect()
    const view = this.board.view
    this.setSelection([card.id])
    view.x = rect.width / 2 - (card.x + card.width / 2) * view.zoom
    view.y = rect.height / 2 - (card.y + card.height / 2) * view.zoom
    this.applyTransform()
    this.scheduleSave(false)
  }

  openSearch(): void {
    if (!this.board) return
    new CardSearchModal(this.app, this.board.cards, (card) => this.focusCard(card)).open()
  }

  startPresentation(): void {
    if (!this.board) return
    if (!this.board.cards.length) {
      new Notice("无限画布里还没有卡片")
      return
    }
    this.presenting = [...this.board.cards].sort((a, b) => a.z - b.z).map((c) => c.id)
    this.presentIndex = 0
    this.showPresentation()
  }

  private nextPresentation(): void {
    if (!this.presenting) return
    if (this.presentIndex >= this.presenting.length - 1) {
      this.stopPresentation()
      return
    }
    this.presentIndex++
    this.showPresentation()
  }

  private prevPresentation(): void {
    if (!this.presenting) return
    this.presentIndex = Math.max(0, this.presentIndex - 1)
    this.showPresentation()
  }

  private stopPresentation(): void {
    this.presenting = null
    this.presentHud?.remove()
    this.presentHud = null
  }

  private showPresentation(): void {
    if (!this.board || !this.presenting || !this.canvasEl) return
    const card = findCard(this.board, this.presenting[this.presentIndex])
    if (!card) return
    const rect = this.canvasEl.getBoundingClientRect()
    const view = this.board.view
    const zoom = clamp(
      Math.min(
        (rect.width - 160) / Math.max(1, card.width),
        (rect.height - 160) / Math.max(1, card.height),
      ),
      0.3,
      1.6,
    )
    view.zoom = zoom
    view.x = rect.width / 2 - (card.x + card.width / 2) * zoom
    view.y = rect.height / 2 - (card.y + card.height / 2) * zoom
    this.setSelection([card.id])
    this.applyTransform()

    if (!this.presentHud) {
      const hud = this.contentEl.createDiv({ cls: "ls-board-present-hud" })
      hud.createDiv({ cls: "ls-present-count" })
      const prev = hud.createEl("button", { text: "◀", cls: "ls-present-btn" })
      prev.onclick = (e) => {
        e.stopPropagation()
        this.prevPresentation()
      }
      const next = hud.createEl("button", { text: "▶", cls: "ls-present-btn" })
      next.onclick = (e) => {
        e.stopPropagation()
        this.nextPresentation()
      }
      const exit = hud.createEl("button", { text: "退出", cls: "ls-present-btn" })
      exit.onclick = (e) => {
        e.stopPropagation()
        this.stopPresentation()
      }
      this.presentHud = hud
    }
    const counter = this.presentHud.querySelector<HTMLElement>(".ls-present-count")
    counter?.setText(`${this.presentIndex + 1} / ${this.presenting.length}`)
  }

  // ================= 编辑弹窗 =================

  private promptText(title: string, initial: string, onSave: (value: string) => void): void {
    new TextPromptModal(this.app, title, initial, onSave).open()
  }

  private editTodoCard(card: BoardCard): void {
    if (!this.board) return
    const items = Array.isArray(card.content.items)
      ? (card.content.items as Array<{ text: string; done?: boolean }>).map((item) => ({
          text: String(item?.text ?? ""),
          done: item?.done === true,
        }))
      : []
    new TodoCardEditorModal(this.app, items, (next) => {
      this.pushUndo()
      card.content.items = next
      this.scheduleSave()
      this.render()
    }).open()
  }

  /** 整块无限画布导出为 PNG（按内容包围盒绘制，不依赖 DOM 截图） */
  async exportBoardPng(): Promise<void> {
    if (!this.board || !this.file) return
    const cards = this.board.cards
    if (!cards.length) {
      new Notice("无限画布里还没有卡片")
      return
    }
    const minX = Math.min(...cards.map((c) => c.x))
    const minY = Math.min(...cards.map((c) => c.y))
    const maxX = Math.max(...cards.map((c) => c.x + c.width))
    const maxY = Math.max(...cards.map((c) => c.y + c.height))
    const pad = 48
    const scale = Math.min(2, 4096 / Math.max(1, maxX - minX + pad * 2))
    const width = Math.round((maxX - minX + pad * 2) * scale)
    const height = Math.round((maxY - minY + pad * 2) * scale)

    const canvasEl = document.createElement("canvas")
    canvasEl.width = width
    canvasEl.height = height
    const ctx = canvasEl.getContext("2d")
    if (!ctx) return

    const css = (name: string, fallback: string) =>
      getComputedStyle(document.body).getPropertyValue(name).trim() || fallback
    const bg = css("--background-primary", "#ffffff")
    const cardBg = css("--background-secondary", "#f5f5f5")
    const fg = css("--text-normal", "#222222")
    const muted = css("--text-muted", "#666666")
    const border = css("--background-modifier-border", "#d0d0d0")

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)
    ctx.save()
    ctx.scale(scale, scale)
    ctx.translate(pad - minX, pad - minY)

    // 分栏
    for (const col of this.board.columns) {
      ctx.fillStyle = "rgba(127,127,127,0.06)"
      ctx.fillRect(col.x, col.y, col.width, col.height)
      ctx.strokeStyle = border
      ctx.strokeRect(col.x, col.y, col.width, col.height)
      ctx.fillStyle = muted
      ctx.font = "12px sans-serif"
      ctx.fillText(col.title || "分栏", col.x + 12, col.y + 22)
    }

    // 编组
    for (const group of this.board.groups) {
      const members = group.cardIds.map((id) => findCard(this.board!, id)).filter((c): c is BoardCard => !!c)
      if (!members.length) continue
      const gx = Math.min(...members.map((c) => c.x)) - 12
      const gy = Math.min(...members.map((c) => c.y)) - 34
      const gw = Math.max(...members.map((c) => c.x + c.width)) - gx + 12
      const gh = Math.max(...members.map((c) => c.y + c.height)) - gy + 12
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = border
      ctx.strokeRect(gx, gy, gw, gh)
      ctx.setLineDash([])
      ctx.fillStyle = muted
      ctx.font = "12px sans-serif"
      ctx.fillText(group.label || "编组", gx + 8, gy + 16)
    }

    // 连线
    ctx.strokeStyle = muted
    ctx.lineWidth = 1.5
    for (const edge of this.board.edges) {
      const from = findCard(this.board, edge.from.cardId)
      const to = findCard(this.board, edge.to.cardId)
      if (!from || !to) continue
      const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
      const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // 卡片
    for (const card of [...this.board.cards].sort((a, b) => a.z - b.z)) {
      ctx.fillStyle = cardBg
      ctx.strokeStyle = border
      roundRect(ctx, card.x, card.y, card.width, card.height, 8)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = fg
      ctx.font = "bold 13px sans-serif"
      ctx.fillText(clipText(this.cardTitle(card), card.width - 24), card.x + 12, card.y + 24)
      ctx.fillStyle = muted
      ctx.font = "11px sans-serif"
      const body = this.exportCardBody(card)
      const lines = wrapText(ctx, body, card.width - 24)
        .slice(0, Math.max(1, Math.floor((card.height - 44) / 16)))
      lines.forEach((line, index) => {
        ctx.fillText(line, card.x + 12, card.y + 44 + index * 16)
      })
    }
    ctx.restore()

    const blob = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, "image/png"))
    if (!blob) {
      new Notice("导出 PNG 失败")
      return
    }
    const folder = this.file.parent?.path && this.file.parent.path !== "/" ? `${this.file.parent.path}/` : ""
    const base = (this.file.basename || "无限画布").replace(/[\\/:*?"<>|]/g, "-")
    let path = `${folder}${base}.png`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) {
      n++
      path = `${folder}${base} ${n}.png`
    }
    const buffer = await blob.arrayBuffer()
    await this.app.vault.createBinary(path, buffer)
    new Notice(`已导出无限画布图片：${path}`)
  }

  private exportCardBody(card: BoardCard): string {
    switch (card.type) {
      case "note":
        return cardText(card, "md")
      case "noteRef":
        return cardText(card, "path")
      case "link":
        return cardText(card, "url")
      case "image":
        return cardText(card, "path")
      case "mind": {
        const mind = card.content.mind as NestMindFile | undefined
        return mind ? `脑图：${mind.nodes?.length ?? 0} 个节点` : "脑图"
      }
      case "todo": {
        const items = card.content.items
        return Array.isArray(items)
          ? items.map((item: any) => `${item?.done ? "☑" : "☐"} ${item?.text ?? ""}`).join("\n")
          : ""
      }
      default:
        return cardText(card, "path") || cardText(card, "url") || this.cardTitle(card)
    }
  }

  private applyTransform(): void {
    if (!this.worldEl || !this.board) return
    const v = this.board.view
    this.worldEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
  }

  private zoomStep(direction: 1 | -1): void {
    if (!this.board || !this.canvasEl) return
    const view = this.board.view
    const rect = this.canvasEl.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const wx = (cx - view.x) / view.zoom
    const wy = (cy - view.y) / view.zoom
    const next = clamp(view.zoom * (direction > 0 ? 1.2 : 0.8), 0.2, 3)
    view.zoom = next
    view.x = cx - wx * next
    view.y = cy - wy * next
    this.applyTransform()
    this.scheduleSave(false)
  }

  /** 供工具条与剧本生成后的首次打开共用。 */
  zoomToFit(): void {
    this.fitContent()
  }

  private fitContent(): void {
    if (!this.board || !this.canvasEl) return
    const cards = this.board.cards
    if (!cards.length) {
      this.board.view.x = 0
      this.board.view.y = 0
      this.board.view.zoom = 1
      this.applyTransform()
      this.scheduleSave(false)
      return
    }
    const minX = Math.min(...cards.map((c) => c.x))
    const minY = Math.min(...cards.map((c) => c.y))
    const maxX = Math.max(...cards.map((c) => c.x + c.width))
    const maxY = Math.max(...cards.map((c) => c.y + c.height))
    const rect = this.canvasEl.getBoundingClientRect()
    const pad = 60
    const zoom = clamp(
      Math.min(
        (rect.width - pad * 2) / Math.max(1, maxX - minX),
        (rect.height - pad * 2) / Math.max(1, maxY - minY),
      ),
      0.2,
      1.2,
    )
    this.board.view.zoom = zoom
    this.board.view.x = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom
    this.board.view.y = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom
    this.applyTransform()
    this.scheduleSave(false)
  }

  private newNoteAtCenter(at?: BoardPoint): void {
    if (!this.board || this.readOnly) return
    const { x, y } = at ?? this.viewportCenter()
    this.newNoteAt(x - 130, y - 85)
  }

  private newNoteAt(x: number, y: number): void {
    if (!this.board || this.readOnly) return
    const card = createNoteCard(this.board, "", { x, y })
    this.pushUndo()
    this.board.cards.push(card)
    this.setSelection([card.id])
    this.scheduleSave()
    this.render()
    // 直接进入编辑
    const el = this.worldEl?.querySelector<HTMLElement>(`[data-card-id="${card.id}"] .ls-card-body`)
    if (el) this.editNote(card, el)
  }

  private editNote(card: BoardCard, body: HTMLElement): void {
    if (!this.board || this.readOnly || this.editingCardId === card.id) return
    this.editingCardId = card.id
    body.empty()
    const area = body.createEl("textarea", { cls: "ls-card-editor" })
    area.value = cardText(card, "md")
    area.placeholder = "写点什么…"
    area.focus()
    const commit = () => {
      if (!area.isConnected) return
      if (area.value !== cardText(card, "md")) this.pushUndo()
      card.content.md = area.value
      this.editingCardId = null
      this.scheduleSave()
      // 重新渲染当前卡内容
      body.empty()
      void this.renderCardBody(card, body)
    }
    area.addEventListener("blur", commit)
    area.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        area.blur()
      }
    })
  }

  // ================= 连线 =================

  private renderEdges(): void {
    if (!this.edgeLayer || !this.board) return
    this.edgeLayer.replaceChildren()
    const board = this.board
    const lookup = new Map(board.cards.map((c) => [c.id, c]))

    // 箭头标记
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs")
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker")
    marker.setAttribute("id", "ls-edge-arrow")
    marker.setAttribute("markerWidth", "8")
    marker.setAttribute("markerHeight", "8")
    marker.setAttribute("refX", "7")
    marker.setAttribute("refY", "4")
    marker.setAttribute("orient", "auto")
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path")
    arrow.setAttribute("d", "M0,0 L8,4 L0,8 Z")
    arrow.setAttribute("fill", "var(--text-faint)")
    marker.appendChild(arrow)
    defs.appendChild(marker)
    this.edgeLayer.appendChild(defs)

    for (const edge of board.edges) {
      const from = lookup.get(edge.from.cardId)
      const to = lookup.get(edge.to.cardId)
      if (!from || !to) continue
      const a = this.edgeAnchor(from, edge.from)
      const b = this.edgeAnchor(to, edge.to)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", this.edgePath(a, b, edge))
      path.setAttribute(
        "stroke",
        edge.color && /^#/.test(edge.color) ? edge.color : "var(--text-faint)",
      )
      path.setAttribute("stroke-width", "1.5")
      path.setAttribute("fill", "none")
      if (edge.style === "dashed") path.setAttribute("stroke-dasharray", "6 4")
      if (edge.toEnd === "arrow") path.setAttribute("marker-end", "url(#ls-edge-arrow)")
      path.addClass("ls-board-edge")
      path.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.showEdgeMenu(edge, e)
      })
      this.edgeLayer.appendChild(path)

      if (edge.label) {
        const midX = (a.x + b.x) / 2
        const midY = (a.y + b.y) / 2
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text")
        text.setAttribute("x", String(midX))
        text.setAttribute("y", String(midY - 6))
        text.setAttribute("text-anchor", "middle")
        text.setAttribute("fill", "var(--text-muted)")
        text.setAttribute("font-size", "11")
        text.setAttribute("class", "ls-board-edge-label")
        text.textContent = edge.label
        this.edgeLayer.appendChild(text)
      }
    }
    // renderEdges 会重建 SVG；拖线过程中将临时线重新挂回最上层
    if (this.edgeDraft) this.edgeLayer.appendChild(this.edgeDraft.path)
  }

  private showEdgeMenu(edge: BoardEdge, event: MouseEvent): void {
    if (this.readOnly) return
    const menu = new Menu()
    menu.addItem((item) =>
      item.setTitle("编辑标签").setIcon("pencil").onClick(() =>
        this.promptText("连线标签", edge.label ?? "", (value) => {
          this.pushUndo()
          edge.label = value.trim()
          this.scheduleSave()
          this.render()
        }),
      ),
    )
    menu.addItem((item) =>
      item
        .setTitle(edge.toEnd === "arrow" ? "去掉箭头" : "加上箭头")
        .setIcon("move-right")
        .onClick(() => {
          this.pushUndo()
          edge.toEnd = edge.toEnd === "arrow" ? "none" : "arrow"
          this.scheduleSave()
          this.render()
        }),
    )
    menu.addItem((item) =>
      item
        .setTitle(edge.style === "dashed" ? "改为实线" : "改为虚线")
        .setIcon("pen-line")
        .onClick(() => {
          this.pushUndo()
          edge.style = edge.style === "dashed" ? "solid" : "dashed"
          this.scheduleSave()
          this.render()
        }),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle("删除连线").setIcon("trash").onClick(() => {
        this.pushUndo()
        this.board!.edges = this.board!.edges.filter((e) => e.id !== edge.id)
        this.scheduleSave()
        this.render()
      }),
    )
    menu.showAtMouseEvent(event)
  }

  private edgeAnchor(card: BoardCard, endpoint: BoardEdge["from"]): { x: number; y: number } {
    if (endpoint.point) return endpoint.point
    const halfW = card.width / 2
    const halfH = card.height / 2
    switch (endpoint.side) {
      case "top":
        return { x: card.x + halfW, y: card.y }
      case "bottom":
        return { x: card.x + halfW, y: card.y + card.height }
      case "left":
        return { x: card.x, y: card.y + halfH }
      case "right":
        return { x: card.x + card.width, y: card.y + halfH }
      default:
        return { x: card.x + halfW, y: card.y + halfH }
    }
  }

  private edgePath(
    a: { x: number; y: number },
    b: { x: number; y: number },
    edge: BoardEdge,
  ): string {
    if (edge.routing === "smart") {
      const midX = (a.x + b.x) / 2
      return `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`
    }
    if (edge.routing === "curve") {
      const midX = (a.x + b.x) / 2
      return `M ${a.x} ${a.y} C ${midX} ${a.y} ${midX} ${b.y} ${b.x} ${b.y}`
    }
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  }
}

// ================= 脑图选择器 / 节点编辑器 =================

class NestMindPickerModal extends FuzzySuggestModal<TFile> {
  private resolve: (file: TFile | null) => void = () => {}
  private chosen = false

  constructor(app: App) {
    super(app)
    this.setPlaceholder("选择要插入无限画布的 .nestmind 脑图")
  }

  pick(): Promise<TFile | null> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => f.extension === "nestmind")
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  getItemText(file: TFile): string {
    return file.path
  }

  onChooseItem(file: TFile): void {
    this.chosen = true
    this.resolve(file)
  }

  onClose(): void {
    super.onClose()
    if (!this.chosen) this.resolve(null)
  }
}

/**
 * 脑图卡片节点编辑器：内嵌脑图与 .nestmind 共用。
 * 只做节点树编辑（改文字、加子节点/兄弟节点、删除），保存时写回卡片或文件。
 */
class MindCardEditorModal extends Modal {
  private mind: NestMindFile
  private onSave: (mind: NestMindFile) => void | Promise<void>

  constructor(app: App, mind: NestMindFile, onSave: (mind: NestMindFile) => void | Promise<void>) {
    super(app)
    this.mind = mind
    this.onSave = onSave
  }

  onOpen(): void {
    this.modalEl.addClass("ls-mind-card-modal")
    this.titleEl.setText("编辑脑图卡片")
    this.renderBody()
  }

  private renderBody(): void {
    this.contentEl.empty()

    const titleRow = this.contentEl.createDiv({ cls: "ls-mind-modal-title-row" })
    titleRow.createSpan({ text: "标题" })
    const title = titleRow.createEl("input", { cls: "ls-mind-modal-input" })
    title.value = this.mind.meta.title
    title.onchange = () => {
      this.mind.meta.title = title.value.trim() || "脑图"
    }

    const tree = this.contentEl.createDiv({ cls: "ls-mind-modal-tree" })
    this.renderNode(tree, this.mind.rootId, 0)
  }

  private renderNode(parent: HTMLElement, nodeId: string, depth: number): void {
    const node = mindNodeById(this.mind, nodeId)
    if (!node) return
    const row = parent.createDiv({ cls: "ls-mind-modal-row" })
    row.style.paddingLeft = `${depth * 18}px`

    const input = row.createEl("input", { cls: "ls-mind-modal-input" })
    input.value = node.text
    input.onchange = () => {
      node.text = input.value
      touchNestMind(this.mind)
    }

    const addChild = row.createEl("button", { text: "＋子" })
    addChild.title = "添加子节点"
    addChild.onclick = () => {
      addMindChild(this.mind, node.id, "新节点")
      this.renderBody()
    }

    if (node.parentId) {
      const addSibling = row.createEl("button", { text: "＋兄" })
      addSibling.title = "添加兄弟节点"
      addSibling.onclick = () => {
        this.addSibling(node)
        this.renderBody()
      }
      const del = row.createEl("button", { text: "删除" })
      del.onclick = () => {
        removeMindNode(this.mind, node.id)
        this.renderBody()
      }
    }

    for (const child of mindChildren(this.mind, node.id)) {
      this.renderNode(parent, child.id, depth + 1)
    }
  }

  private addSibling(node: MindNode): void {
    if (!node.parentId) return
    const siblings = mindChildren(this.mind, node.parentId)
    for (const s of siblings) {
      if (s.order > node.order) s.order++
    }
    this.mind.nodes.push({
      id: makeId("n"),
      text: "新节点",
      note: "",
      parentId: node.parentId,
      order: node.order + 1,
    })
    touchNestMind(this.mind)
  }

  onClose(): void {
    void this.onSave(this.mind)
    this.contentEl.empty()
  }
}

// ================= 通用小工具 / 弹窗 =================

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

function clipText(text: string, maxWidth: number): string {
  const maxChars = Math.max(4, Math.floor(maxWidth / 13))
  const chars = Array.from(text)
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : text
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = []
  for (const rawLine of (text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine) {
      out.push("")
      continue
    }
    let line = ""
    for (const ch of Array.from(rawLine)) {
      const test = line + ch
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line)
        line = ch
      } else {
        line = test
      }
    }
    if (line) out.push(line)
  }
  return out
}

class TextPromptModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly initial: string,
    private readonly onSave: (value: string) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.title)
    const input = this.contentEl.createEl("input", { type: "text", cls: "ls-prompt-input" })
    input.value = this.initial
    input.style.width = "100%"
    const row = this.contentEl.createDiv({ cls: "ls-dict-editor-actions" })
    const cancel = row.createEl("button", { text: "取消" })
    cancel.onclick = () => this.close()
    const save = row.createEl("button", { text: "保存", cls: "mod-cta" })
    save.onclick = () => {
      this.onSave(input.value)
      this.close()
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        this.onSave(input.value)
        this.close()
      }
    })
    window.setTimeout(() => {
      input.focus()
      input.select()
    }, 40)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

class LinkCardModal extends Modal {
  private url = ""
  private title = ""

  constructor(app: App, private readonly onSave: (url: string, title: string) => void) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText("插入链接卡片")
    new Setting(this.contentEl)
      .setName("网址")
      .setDesc("https://…")
      .addText((text) =>
        text.setPlaceholder("https://example.com").onChange((value) => {
          this.url = value.trim()
        }),
      )
    new Setting(this.contentEl)
      .setName("标题")
      .setDesc("留空则用域名")
      .addText((text) =>
        text.setPlaceholder("链接标题").onChange((value) => {
          this.title = value.trim()
        }),
      )
    const row = this.contentEl.createDiv({ cls: "ls-dict-editor-actions" })
    const cancel = row.createEl("button", { text: "取消" })
    cancel.onclick = () => this.close()
    const save = row.createEl("button", { text: "插入", cls: "mod-cta" })
    save.onclick = () => {
      if (!this.url) {
        new Notice("请填写网址")
        return
      }
      this.onSave(this.url, this.title || domainOf(this.url))
      this.close()
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

class TodoCardEditorModal extends Modal {
  private draft: string

  constructor(
    app: App,
    items: Array<{ text: string; done: boolean }>,
    private readonly onSave: (items: Array<{ text: string; done: boolean }>) => void,
  ) {
    super(app)
    this.draft = items
      .map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text}`)
      .join("\n")
  }

  onOpen(): void {
    this.titleEl.setText("编辑待办")
    this.contentEl.createDiv({
      cls: "setting-item-description",
      text: "一行一项；已完成的以 [x] 开头，未完成用 [ ]。",
    })
    const area = this.contentEl.createEl("textarea", { cls: "ls-card-editor" })
    area.value = this.draft
    area.rows = 10
    area.style.width = "100%"
    area.addEventListener("input", () => {
      this.draft = area.value
    })
    const row = this.contentEl.createDiv({ cls: "ls-dict-editor-actions" })
    const cancel = row.createEl("button", { text: "取消" })
    cancel.onclick = () => this.close()
    const save = row.createEl("button", { text: "保存", cls: "mod-cta" })
    save.onclick = () => {
      const items = this.draft
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^\[(x|X| )\]\s*(.*)$/.exec(line)
          if (match) return { text: match[2], done: match[1].toLowerCase() === "x" }
          return { text: line, done: false }
        })
      this.onSave(items)
      this.close()
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

class VaultFilePickerModal extends FuzzySuggestModal<TFile> {
  private resolve: (file: TFile | null) => void = () => {}
  private chosen = false

  constructor(
    app: App,
    private readonly filter: (file: TFile) => boolean,
    placeholder: string,
  ) {
    super(app)
    this.setPlaceholder(placeholder)
  }

  pick(): Promise<TFile | null> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => this.filter(file))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  getItemText(file: TFile): string {
    return file.path
  }

  onChooseItem(file: TFile): void {
    this.chosen = true
    this.resolve(file)
  }

  onClose(): void {
    super.onClose()
    if (!this.chosen) this.resolve(null)
  }
}

class CardSearchModal extends FuzzySuggestModal<BoardCard> {
  constructor(
    app: App,
    private readonly cards: BoardCard[],
    private readonly onPick: (card: BoardCard) => void,
  ) {
    super(app)
    this.setPlaceholder("搜索卡片标题 / 正文 / 路径")
  }

  getItems(): BoardCard[] {
    return [...this.cards].sort((a, b) => a.z - b.z)
  }

  getItemText(card: BoardCard): string {
    const text =
      cardText(card, "md") ||
      cardText(card, "path") ||
      cardText(card, "url") ||
      cardText(card, "caption") ||
      ""
    const title = card.title || card.type
    return `${title} · ${card.type}${text ? ` · ${text.slice(0, 80)}` : ""}`
  }

  onChooseItem(card: BoardCard): void {
    this.onPick(card)
  }
}
