/**
 * 导图视图 —— 吸收 gogoga-mindmap 的完整节点编辑内核
 *
 * Markdown 仍是唯一真相源：打开时 parseMarkdown → 画布，编辑后 serializeMarkdown
 * 防抖写回；外部修改会重新解析并保留视口/选中。
 *
 * 画布本身来自 vendored gogoga-mindmap（MIT），提供：
 *  - 内联编辑（CodeMirror 6）、节点备注、Tab 缩进 / Shift+Tab 提升
 *  - 加子节点 / 兄弟节点 / 插入父节点 / 删除子树 / 仅删自己
 *  - 折叠展开、框选、多选、拖拽换父、自由主题
 *  - 节点颜色、emoji 标记、优先级/进度、概要、外框、关联线、标注
 *  - 搜索、适应画布、缩放、结构切换、主题切换
 */

import {
  finishRenderMath,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  renderMath,
  TFile,
  WorkspaceLeaf,
  setTooltip,
  type MenuItem,
} from "obsidian"
import {
  MindMapCanvas,
  flattenMenu,
  type CanvasHost,
  type MenuEntry,
  type NodeCommand,
} from "../mindmap/upstream/canvas"
import { parseMarkdown, serializeMarkdown } from "../mindmap/upstream/markdown"
import { buildSvg, svgToPng } from "../mindmap/upstream/export"
import { History } from "../mindmap/upstream/history"
import type { MindDoc } from "../mindmap/upstream/model"
import type { Structure } from "../mindmap/upstream/layout"
import type { ThemeId } from "../mindmap/upstream/theme"

export const MINDMAP_VIEW_TYPE = "lenscript-mindmap"

interface SavedUiState {
  structure?: Structure
  theme?: ThemeId
}

export class MindmapView extends ItemView {
  private canvas: MindMapCanvas | null = null
  private wrapEl: HTMLElement | null = null
  private file: TFile | null = null
  private currentMarkdown = ""
  private history = new History()
  private saveTimer = 0
  private writing = false
  private titleEl: HTMLElement | null = null
  private safetyEl: HTMLElement | null = null
  private roundtripSafe = true
  private allowUnsafeEdit = false
  private pendingFilePath: string | null = null
  private lastError: string | null = null
  private eventsBound = false

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return MINDMAP_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.file ? `导图 · ${this.file.basename}` : "导图 · 镜语"
  }

  getIcon(): string {
    return "git-fork"
  }

  /** 视图状态里带上文件路径：新开标签页时活动文件可能已经切走 */
  getState(): Record<string, unknown> {
    const base = super.getState()
    return {
      ...base,
      file: this.file?.path ?? this.pendingFilePath ?? "",
    }
  }

  async setState(state: any, result: any): Promise<void> {
    if (state && typeof state.file === "string" && state.file) {
      this.pendingFilePath = state.file
    }
    await super.setState(state, result)
    // Obsidian 可能先 setState 后 onOpen；此时 UI 还没建，先补挂载
    window.setTimeout(() => {
      if (!this.wrapEl) {
        void this.mountUi()
        return
      }
      if (this.file) return
      const file = this.pendingFilePath
        ? this.app.vault.getAbstractFileByPath(this.pendingFilePath)
        : null
      if (file instanceof TFile) void this.loadFile(file)
    }, 0)
    // 布局延迟时再兜两次
    window.setTimeout(() => {
      if (!this.wrapEl) void this.mountUi()
    }, 120)
    window.setTimeout(() => {
      if (!this.wrapEl) void this.mountUi()
    }, 500)
  }

  /** contentEl 在个别生命周期时机不可用；兜底到 containerEl 里自建容器 */
  private getHostEl(): HTMLElement {
    const content = (this as any).contentEl as HTMLElement | undefined
    if (content) return content
    let fallback = this.containerEl.querySelector<HTMLElement>(".ls-mm-fallback")
    if (!fallback) {
      fallback = this.containerEl.createDiv({ cls: "ls-mm-fallback" })
    }
    return fallback
  }

  private resolveTargetFile(): TFile | null {
    if (this.pendingFilePath) {
      const file = this.app.vault.getAbstractFileByPath(this.pendingFilePath)
      if (file instanceof TFile) return file
    }
    const active = this.app.workspace.getActiveFile()
    if (active instanceof TFile && active.extension === "md") return active
    // 自定义视图被激活时 getActiveFile() 常为 null；用最近打开列表兜底
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getAbstractFileByPath(path)
      if (file instanceof TFile && file.extension === "md") return file
    }
    return null
  }

  /** 手动重新载入：用于视图空白/切换笔记后没有刷新 */
  async reloadActive(): Promise<void> {
    const file = this.resolveTargetFile()
    if (!file) {
      this.showEmpty("没有可载入的 Markdown 笔记")
      return
    }
    this.file = null
    await this.loadFile(file)
  }

  async onOpen(): Promise<void> {
    try {
      await this.mountUi()
    } catch (e) {
      this.reportOpenError(e)
    }
  }

  private async mountUi(): Promise<void> {
    if (this.wrapEl) return
    const host = this.getHostEl()
    this.containerEl.addClass("ls-mindmap-view")
    host.addClass("ls-mindmap-content")
    host.empty()

    const bar = host.createDiv({ cls: "ls-mm-bar" })
    this.titleEl = bar.createDiv({ cls: "ls-mm-title" })
    this.titleEl.setText("导图")
    const hint = bar.createDiv({ cls: "ls-mm-hint" })
    hint.setText("编辑实时写回 Markdown · Tab 缩进 / Shift+Tab 提升")

    this.safetyEl = bar.createDiv({ cls: "ls-mm-safety" })
    this.safetyEl.hide()
    this.safetyEl.createSpan({
      cls: "ls-mm-safety-text",
      text: "此笔记不是标准导图结构，直接编辑会重排空行与标记；默认只读预览。",
    })
    const unlock = this.safetyEl.createEl("button", {
      cls: "ls-mm-safety-btn",
      text: "仍然编辑",
    })
    unlock.onclick = () => {
      this.allowUnsafeEdit = true
      this.canvas?.setEditable(true)
      this.safetyEl?.hide()
      new Notice("已解锁编辑：保存时会按导图结构重写此 Markdown，建议先备份")
    }

    this.wrapEl = host.createDiv({ cls: "ls-mm-wrap" })
    this.ensureCanvas()

    if (!this.eventsBound) {
      this.eventsBound = true
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (file) void this.loadFile(file)
        }),
      )
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file === this.file) void this.onExternalModify(file)
        }),
      )
    }

    const target = this.resolveTargetFile()
    if (target) await this.loadFile(target)
    else this.showEmpty("打开一个 Markdown 文件开始编辑导图")
  }

  private reportOpenError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? (e.stack ?? message) : message
    this.lastError = stack
    console.error("[lenscript] mindmap view open failed", e)
    new Notice(`导图视图初始化失败：${message}`, 10000)
    try {
      this.containerEl.empty()
      const box = this.containerEl.createDiv({ cls: "ls-mm-empty" })
      box.createDiv({ text: `导图视图初始化失败：${message}` })
      box.createDiv({ cls: "ls-mm-error-stack", text: stack })
    } catch {
      // 连错误都画不出来时只能依赖控制台
    }
  }

  async onClose(): Promise<void> {
    await this.flushWrite()
    this.canvas?.destroy()
    this.canvas = null
  }

  // ============ 文件加载 / 写回 ============

  private async loadFile(file: TFile): Promise<void> {
    if (file.extension !== "md") {
      this.showEmpty(`当前文件不是 Markdown：${file.path}`)
      return
    }
    // UI 还没挂载：先记住文件，等 mountUi 建好容器后再真正载入
    if (!this.wrapEl) {
      this.pendingFilePath = file.path
      await this.mountUi()
      return
    }
    if (this.file?.path === file.path) return

    await this.flushWrite()
    this.file = file
    this.currentMarkdown = await this.app.vault.read(file)
    this.history.reset()
    this.allowUnsafeEdit = false
    this.titleEl?.setText(`导图 · ${file.basename}`)
    this.ensureCanvas()
    this.applyMarkdown(this.currentMarkdown, false)
    this.checkRoundtrip()
  }

  private ensureCanvas(): void {
    if (this.canvas) return
    if (!this.wrapEl) {
      this.lastError = "wrapEl 不存在：视图内容没有挂载"
      new Notice("导图视图没有挂载内容容器，请关闭该标签后重新执行「切换导图视图」", 10000)
      return
    }
    this.wrapEl.empty()
    this.wrapEl.removeClass("is-empty")
    const saved = this.readUiState()
    try {
      this.canvas = new MindMapCanvas(this.wrapEl, {
        structure: saved.structure ?? "logic-right",
        theme: saved.theme ?? "snow",
        editable: true,
        host: this.makeHost(),
        onChange: (doc) => this.onCanvasChange(doc),
        onUndo: () => this.undo(),
        onRedo: () => this.redo(),
        onStructureChange: (structure) => this.saveUiState({ structure }),
        onThemeChange: (theme) => this.saveUiState({ theme }),
        onSelectionChange: () => {},
      })
    } catch (e) {
      this.canvas = null
      this.lastError = e instanceof Error ? (e.stack ?? e.message) : String(e)
      const message = e instanceof Error ? e.message : String(e)
      new Notice(`导图画布初始化失败：${message}`, 12000)
      this.wrapEl.empty()
      this.wrapEl.addClass("is-empty")
      this.wrapEl.createDiv({
        cls: "ls-mm-empty",
        text: `导图画布初始化失败：${e instanceof Error ? e.message : String(e)}`,
      })
      console.error("[lenscript] mindmap canvas init failed", e)
    }
  }

  /** 非标准结构调整后能否逐字回写；不能则默认只读，避免误伤普通笔记 */
  private checkRoundtrip(): void {
    if (!this.canvas || !this.file) return
    let normalized = ""
    try {
      normalized = serializeMarkdown(parseMarkdown(this.currentMarkdown, { fallbackTitle: this.file.basename }))
    } catch {
      normalized = ""
    }
    this.roundtripSafe = normalized === this.currentMarkdown
    if (this.roundtripSafe || this.allowUnsafeEdit) {
      this.canvas.setEditable(true)
      this.safetyEl?.hide()
    } else {
      this.canvas.setEditable(false)
      this.safetyEl?.show()
    }
  }

  private applyMarkdown(md: string, preserveView: boolean): void {
    if (!this.canvas || !this.file) return
    const view = preserveView ? this.canvas.getViewState() : null
    const selected = preserveView ? this.canvas.getSelectedPath() : null
    const doc = parseMarkdown(md, { fallbackTitle: this.file.basename })
    console.log(
      "[lenscript] mindmap load:",
      this.file.path,
      "root=",
      doc.root.text,
      "children=",
      doc.root.children.length,
    )
    this.canvas.setDoc(doc)
    if (view) this.canvas.setViewState(view)
    if (selected) this.canvas.selectPath(selected)
    else if (!preserveView) window.setTimeout(() => this.canvas?.fit(), 80)
    this.wrapEl?.removeClass("is-empty")
  }

  private showEmpty(message: string): void {
    this.canvas?.destroy()
    this.canvas = null
    if (!this.wrapEl) return
    this.wrapEl.empty()
    this.wrapEl.addClass("is-empty")
    const box = this.wrapEl.createDiv({ cls: "ls-mm-empty" })
    box.createDiv({ text: message })
    const btn = box.createEl("button", {
      cls: "ls-mm-safety-btn",
      text: "载入当前活动笔记",
    })
    btn.onclick = () => {
      const file = this.resolveTargetFile()
      if (file) {
        void this.loadFile(file)
      } else {
        new Notice("当前没有活动 Markdown 笔记，请先在编辑区打开一篇笔记")
      }
    }
  }

  private onCanvasChange(doc: MindDoc): void {
    if (!this.file) return
    const next = serializeMarkdown(doc)
    if (next === this.currentMarkdown) return
    this.history.push(this.currentMarkdown)
    this.currentMarkdown = next
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flushWrite(), 450)
  }

  private async flushWrite(): Promise<void> {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = 0
    if (!this.file || !this.currentMarkdown) return
    if (this.writing) {
      this.scheduleWrite()
      return
    }
    const md = this.currentMarkdown
    if (!md) return
    try {
      const current = await this.app.vault.read(this.file)
      if (current === md) return
      this.writing = true
      await this.app.vault.modify(this.file, md)
    } catch (e) {
      new Notice(`导图写回失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      // 让 modify 事件的回调越过本次自写
      window.setTimeout(() => {
        this.writing = false
      }, 50)
    }
  }

  private async onExternalModify(file: TFile): Promise<void> {
    if (this.writing || file !== this.file) return
    try {
      const md = await this.app.vault.read(file)
      if (md === this.currentMarkdown) return
      this.currentMarkdown = md
      this.applyMarkdown(md, true)
    } catch {
      // 文件可能正在被外部写入，下一轮再同步
    }
  }

  private undo(): void {
    const prev = this.history.undo(this.currentMarkdown)
    if (prev === null) {
      new Notice("没有可撤销的导图操作")
      return
    }
    this.currentMarkdown = prev
    this.applyMarkdown(prev, true)
    this.scheduleWrite()
  }

  private redo(): void {
    const next = this.history.redo(this.currentMarkdown)
    if (next === null) {
      new Notice("没有可重做的导图操作")
      return
    }
    this.currentMarkdown = next
    this.applyMarkdown(next, true)
    this.scheduleWrite()
  }

  // ============ 供命令调用 ============

  runNodeCommand(cmd: NodeCommand): void {
    this.canvas?.runNodeCommand(cmd)
  }

  focusCanvas(): void {
    this.canvas?.focus()
  }

  getCanvas(): MindMapCanvas | null {
    return this.canvas
  }

  /** 导出当前导图为同名 SVG（与笔记同目录） */
  async exportSvgFile(): Promise<void> {
    if (!this.canvas || !this.file) {
      new Notice("请先打开一个 Markdown 文件")
      return
    }
    try {
      const exp = await buildSvg(this.canvas, {})
      const path = await this.uniqueExportPath("svg")
      await this.app.vault.create(path, exp.svg)
      new Notice(`已导出：${path}`)
    } catch (e) {
      new Notice(`导出 SVG 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 导出当前导图为同名 PNG（2 倍缩放） */
  async exportPngFile(): Promise<void> {
    if (!this.canvas || !this.file) {
      new Notice("请先打开一个 Markdown 文件")
      return
    }
    try {
      const exp = await buildSvg(this.canvas, {})
      const blob = await svgToPng(exp, 2)
      const buf = await blob.arrayBuffer()
      const path = await this.uniqueExportPath("png")
      await this.app.vault.createBinary(path, buf)
      new Notice(`已导出：${path}`)
    } catch (e) {
      new Notice(`导出 PNG 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async uniqueExportPath(ext: string): Promise<string> {
    const file = this.file!
    const folder = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : ""
    let path = `${folder}${file.basename}.${ext}`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) {
      n++
      path = `${folder}${file.basename} ${n}.${ext}`
    }
    return path
  }

  openSearch(): void {
    this.canvas?.openSearch()
  }

  setFoldLevel(level: number | null): void {
    this.canvas?.setFoldLevel(level)
  }

  /** 诊断信息：空白时用来判断是没载入文件、还是画布尺寸/渲染问题 */
  debugInfo(): Record<string, unknown> {
    const doc = this.canvas?.getDoc()
    return {
      file: this.file?.path ?? null,
      pendingFile: this.pendingFilePath,
      lastOpenFiles: this.app.workspace.getLastOpenFiles().slice(0, 5),
      canvasCreated: !!this.canvas,
      wrapExists: !!this.wrapEl,
      lastError: this.lastError,
      root: doc?.root.text ?? null,
      rootChildren: doc?.root.children.length ?? null,
      wrapWidth: this.wrapEl?.clientWidth ?? 0,
      wrapHeight: this.wrapEl?.clientHeight ?? 0,
      editable: this.canvas?.isEditable() ?? null,
      roundtripSafe: this.roundtripSafe,
    }
  }

  // ============ 画布宿主适配 ============

  private makeHost(): CanvasHost {
    return {
      renderNote: (el, markdown) => {
        void MarkdownRenderer.render(
          this.app,
          markdown,
          el,
          this.file?.path ?? "",
          this,
        ).catch(() => {
          el.setText(markdown)
        })
      },
      openLink: (href, internal, ev) => {
        if (internal) {
          void this.app.workspace.openLinkText(
            href,
            this.file?.path ?? "",
            ev.ctrlKey || ev.metaKey,
          )
        } else {
          window.open(href, "_blank")
        }
      },
      notice: (message) => new Notice(message),
      setTooltip: (el, text) => setTooltip(el, text, { placement: "top" }),
      renderMath: (tex) => renderMath(tex, false),
      afterRender: () => void finishRenderMath(),
      fileBasename: () => this.file?.basename ?? "",
      resolveImage: (link) => {
        const raw = link.replace(/^!/, "").replace(/^\[\[|\]\]$/g, "")
        if (/^(https?:|data:)/i.test(raw)) return raw
        const dest = this.app.metadataCache.getFirstLinkpathDest(
          raw,
          this.file?.path ?? "",
        )
        return dest ? this.app.vault.adapter.getResourcePath(dest.path) : null
      },
      listLinkTargets: () =>
        this.app.vault.getMarkdownFiles().map((f) => ({
          name: f.basename,
          folder: f.parent?.path ?? "",
          linktext: f.path.replace(/\.md$/i, ""),
          isNote: true,
        })),
      saveBinary: async (name, data) => {
        const folder = "attachments"
        if (!this.app.vault.getAbstractFileByPath(folder)) {
          await this.app.vault.createFolder(folder).catch(() => {})
        }
        let path = `${folder}/${name}`
        let n = 1
        while (this.app.vault.getAbstractFileByPath(path)) {
          const dot = name.lastIndexOf(".")
          path = `${folder}/${dot >= 0 ? name.slice(0, dot) + " " + n + name.slice(dot) : name + " " + n}`
          n++
        }
        await this.app.vault.createBinary(path, data)
        return path
      },
      showMenu: (entries, ev, onClose) => {
        const menu = new Menu()
        for (const entry of flattenMenu(entries)) this.addMenuItem(menu, entry)
        menu.onHide(() => onClose?.())
        menu.showAtMouseEvent(ev)
      },
    }
  }

  private addMenuItem(menu: Menu, entry: MenuEntry): void {
    if (entry.separator) {
      menu.addSeparator()
      return
    }
    menu.addItem((item: MenuItem) => {
      item.setTitle(entry.title ?? "")
      if (entry.icon) item.setIcon(entry.icon)
      if (entry.checked !== undefined) item.setChecked(entry.checked)
      if (entry.disabled) item.setDisabled(true)
      item.onClick(() => entry.run?.())
    })
  }

  // ============ 视图偏好 ============

  private uiStateKey(): string | null {
    return this.file ? `lenscript-mindmap-ui:${this.file.path}` : null
  }

  private readUiState(): SavedUiState {
    const key = this.uiStateKey()
    if (!key) return {}
    try {
      const raw = window.localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as SavedUiState) : {}
    } catch {
      return {}
    }
  }

  private saveUiState(patch: SavedUiState): void {
    const key = this.uiStateKey()
    if (!key) return
    try {
      const next = { ...this.readUiState(), ...patch }
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // 忽略存储失败
    }
  }
}
