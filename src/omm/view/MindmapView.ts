/**
 * 导图视图。M5 起可编辑。
 *
 * 数据流（第 4.1 节，单向）：
 *   文件内容 → parse → reconcile（保住 id / 折叠态）→ layout → DOM
 *
 * 【编辑走的是同一条单向流】，只是把「等文件事件回来」换成了同步自算：
 *   意图 → planEdit → EditPlan → 本地 applyPlan 得到新文本 → refresh（同步）
 *                              └→ DocumentBridge 排队落盘（异步，不挡交互）
 * 树依旧是文本的投影——投影的那份文本，正是我们即将写进文件的那份。
 * 这样连按 10 次回车不必等 10 次 I/O，也就不会丢事件。
 */

import {
  FileView,
  ItemView,
  MarkdownView,
  Notice,
  loadMathJax,
  Menu,
  type TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian'
import { applyPlan } from '../core/editplan'
import { hasAnnotations, type NodeAnnotations } from '../core/annotations'
import { toggleTaskText } from '../core/task'
import { joinLines, parse } from '../core/parser'
import { reconcile } from '../core/reconcile'
import {
  maxDepthDrop,
  mergeIntoNode,
  moveSubtree,
  navigate,
  planEdit,
  removeSubtree,
  renameNode,
  resolveAt,
  selectionAfterRemoval,
  bodyTextOf,
  createRoot,
  hasBody,
  setBody,
  setNodeAnnotations,
  type EditIntent,
  type EditOutcome,
  type MergeMode,
  type NavDirection,
} from '../core/tree'
import type { EditPlan, MindNode, MindTree, ParseOptions } from '../core/types'
import {
  DEFAULT_LAYOUT,
  boundsOf,
  layout,
  rootSide,
  sideOf,
  subtreeBounds,
  visibleNodes,
} from '../layout'
import type { NodeSide } from '../layout'
import type { Box, LayoutDirection, LayoutOptions, LayoutResult } from '../layout/types'
import { DocumentBridge, type DocumentChange } from '../doc/DocumentBridge'
import type { HistoryDirection } from '../doc/FileHistory'
import type { MindmapHost } from '../settings/SettingsTab'
import { NODE_MENU_META, CANVAS_MENU_META, type CanvasMenuAction, type NodeMenuAction } from '../settings/contextMenu'
import { StyleModal } from '../settings/StyleModal'
import { DEFAULT_STYLE, type MindmapStyle } from '../settings/StyleStore'
import { THEME_PRESETS, matchesPreset, type ThemePreset } from '../settings/presets'
import type { NoteMode } from '../settings/OpenAsStore'
import type { ViewportState } from '../settings/ViewPreferences'
import { t } from '../i18n'
import { Annotations } from './Annotations'
import { AnnotationModal } from './AnnotationModal'
import { Canvas } from './Canvas'
import { Connectors } from './Connectors'
import { DragController, isSamePosition, resolveDrop, subtreeIds, targetIsAncestor, type DropResult, type DropTarget } from './DragController'
import { RelationDrag } from './RelationDrag'
import { InlineEditor, BodyInlineEditor, type CommitNext } from './Editor'
import { exportMap, ExportSizeError } from './exportMap'
import { fileToShow } from './follow'
import { NodeRenderer, type BodySource } from './NodeRenderer'
import { Toolbar } from './Toolbar'
import { LayoutMotion, MOTION_NODE_LIMIT } from './LayoutMotion'
import { searchState, searchTargets, type SearchState } from './search'
import {
  PADDING_Y,
  bodyFont,
  clearMeasureCache,
  measureNode,
  readFont,
  taskBox,
  toggleSize,
  type FontSpec,
  type NodeMetrics,
} from './measure'

export const VIEW_TYPE_MINDMAP = 'lenscript-omm'

/** 移动端长按多久弹菜单（毫秒）。太短会和拖拽抢手势，太长会让人以为没反应。 */
const LONG_PRESS_MS = 500
/** 长按判定期间允许的抖动；超过这个距离就当成拖拽 / 平移。 */
const LONG_PRESS_SLOP = 8
/** 长按弹过菜单之后，多久之内的 click / contextmenu 一律吃掉。 */
const LONG_PRESS_GUARD = 900

/** 草稿节点的 id。它不在文件里，提交前一直只活在内存树上。 */
const DRAFT_ID = '__draft__'

/**
 * 一次编辑会话。
 *
 * `intent` 决定提交时生成哪种 EditPlan；`draft` 为 true 表示正在编辑的是草稿节点
 * （文件里还没有它，Esc 掉就什么都没发生过）。
 */
interface Session {
  node: MindNode
  intent: EditIntent
  draft: boolean
  /** 编辑已有节点时用来 Esc 还原——编辑期间 node.text 是被乐观改掉的。 */
  originalText: string
  /** Esc 之后选中该回到哪儿。取消一次新增，选中就该回到按下 Enter 时的那个节点。 */
  returnTo: string | null
}

export class MindmapView extends ItemView {
  private canvas!: Canvas
  private nodeRenderer!: NodeRenderer
  private connectors!: Connectors
  /** 框 / 概要 / 标注气泡。与连线共用同一张 SVG。 */
  private annotations!: Annotations
  private editor!: InlineEditor
  private bodyEditor!: BodyInlineEditor
  private drag!: DragController
  /** 关联线拖拽绘制。 */
  private relDrag!: RelationDrag
  /** 移动端长按计时：指针不动 500ms 就弹右键菜单。 */
  private longPressTimer: number | null = null
  private longPressStart: { id: number; x: number; y: number } | null = null
  /** 最近一次长按弹菜单的时间，用来吃掉紧随其后的 click / contextmenu。 */
  private longPressAt = 0
  private bridge!: DocumentBridge
  private toolbar!: Toolbar
  private empty!: HTMLElement
  /** 拖拽时出现的「独立」投放区。 */
  private floatDock!: HTMLElement
  /** 自由拖动（带 %%float%% 的独立节点）起始时的整体几何快照。 */
  private freeDragBase: Map<string, Box> | null = null
  /** 自由拖动时要一起平移的节点 id（被拖节点 + 全部后代）。 */
  private freeDragIds: Set<string> | null = null
  /** 就地搜索条（标题 + 正文）。和 Obsidian 搜索进来的高亮分开管理。 */
  private findBar!: HTMLElement
  private findInput!: HTMLInputElement
  private findCount!: HTMLElement
  private findHits: string[] = []
  private findAt = 0
  private findQuery = ''
  /** 背诵模式：只改显示，不写文件。遮住 ==高亮==，点一下揭开。 */
  private recite = false

  private file: TFile | null = null
  private tree: MindTree | null = null
  private font: FontSpec | null = null
  private boxes: LayoutResult = new Map()
  /** 每个可见节点最近一次的测量结果；编辑框定位与正文区高度都从这里取。 */
  private metrics = new Map<string, NodeMetrics>()
  /** 正在编辑正文的节点 id；这段时间里即使正文为空也给它留一块位置。 */
  private editingBodyId: string | null = null
  private bounds: Box = { x: 0, y: 0, w: 0, h: 0 }
  /** 布局方向：与其他样式一样由单篇 / 全局配置解析。 */
  private direction: LayoutDirection = DEFAULT_LAYOUT.direction
  /** 当前笔记生效的样式（M8）：预览 > 单篇 > 全局，由 StyleStore 裁定。 */
  private style: MindmapStyle = DEFAULT_STYLE
  private unsubscribeStyle: (() => void) | null = null
  private unsubscribeViewMode: (() => void) | null = null
  private unsubscribePreferences: (() => void) | null = null
  private initialViewport: ViewportState | undefined
  private styleViewport: ViewportState | undefined
  private previewingStyle = false
  private noteMode: NoteMode = 'source'
  private locked = false
  private forcedLock = false
  private modeObserver: MutationObserver | null = null
  private modeContainers: HTMLElement[] = []
  /**
   * 选中集合。Ctrl+左键可多选（M6），用于批量删除。
   * 【批量移动推迟到 v2】（第 6 章）——拖拽永远只搬 `focusId` 那一棵子树。
   */
  private readonly selection = new Set<string>()
  /** 主选中：方向键、Enter/Tab/F2 都作用在它身上。总是 selection 里的一员。 */
  private focusId: string | null = null
  /** 可见节点 id（文档序），拖拽落点判定要用。draw 时顺手记下，免得再走一遍树。 */
  private order: string[] = []
  private session: Session | null = null
  /** 编辑期间到达的外部变更：先攒着，等编辑结束再刷，免得草稿被冲掉。 */
  private pendingText: string | null = null
  /** 写盘失败后正在重新同步，别把同一个错误弹十遍。 */
  private resyncing = false
  private historyBusy = 0
  private search: { state: SearchState; path: string | null; pending: boolean } | null = null
  private searchBar!: HTMLElement
  private searchFocusId: string | null = null
  private motion!: LayoutMotion
  private reducedMotion: MediaQueryList | null = null
  /** 首次绘制恢复记忆视野；没有记忆时适应画布。尺寸为零时延后。 */
  private needsFit = true
  /** onOpen 是否已经把各个部件建起来了。setState 可能比它先到。 */
  private ready = false
  /**
   * setState 早于 onOpen 时先记在这儿的笔记路径，onOpen 收尾时认领。
   *
   * 「早于 onOpen」= 这个视图正在被创建：要么是「笔记 → 导图」换形态，要么是
   * 恢复工作区。钉住的照办，跟随型的只当回退，取舍见 follow.ts。
   */
  private pendingPath: string | null = null
  /**
   * 钉在一篇笔记上（「打开为导图」换出来的那种），不跟随活动笔记；写进视图状态，重启后仍钉着。
   * 与之相对的是侧边栏图标 / 命令面板打开的【跟随型】导图。
   */
  private pinned = false
  commandMap = false

  get sourceFile(): TFile | null { return this.file }
  /**
   * 只给「跟随自检」命令看的留痕：最近 16 次「该不该换笔记」的判定。
   *
   * 「导图没跟着笔记切换」有三种完全不同的成因——事件没送到、送到了但
   * `getActiveFile()` 还是旧的、或者被某条规则挡下了——光看现象分不出是哪一种，
   * 只看一张事后的快照也分不出（快照上写着「活动笔记没变」，是没变还是没看见？）。
   * 记下【每一次判定的来源、看到的活动笔记、和结论】，切一次笔记就能读出真相。
   *
   * 代价是每次事件往数组里塞一个字符串、超过 16 条丢掉最早的，与节点数无关。
   */
  private readonly trail: string[] = []
  /** 这个视图实例是什么时候建起来的。视图被卸载重建过，事件计数会归零，得看得出来。 */
  private readonly bornAt = Date.now()

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: MindmapHost,
  ) {
    super(leaf)
  }

  override getViewType(): string {
    return VIEW_TYPE_MINDMAP
  }

  override getDisplayText(): string {
    return this.file ? t('view.titleWithNote', this.file.basename) : t('view.title')
  }

  override getIcon(): string {
    return 'network'
  }

  override getEphemeralState(): Record<string, unknown> {
    return this.search ? { ...this.search.state } : {}
  }

  override setEphemeralState(value: unknown): void {
    const state = searchState(value)
    if (!state) return
    this.searchFocusId = null
    this.search = { state, path: this.pendingPath ?? this.file?.path ?? null, pending: true }
    if (this.ready && this.tree) this.applySearch()
  }

  private clearSearch(): void {
    this.search = null
    this.searchFocusId = null
    this.nodeRenderer?.setSearch(new Map())
    this.searchBar?.empty()
    this.searchBar?.addClass('is-hidden')
  }

  private applySearch(): void {
    const request = this.search
    const tree = this.tree
    if (!request || !tree || !this.file || !this.ready) return
    if (request.path !== null && request.path !== this.file.path) { this.clearSearch(); this.draw(); return }
    const targets = searchTargets(tree, request.state)
    if (!targets) {
      this.clearSearch()
      this.draw()
      new Notice(t('notice.searchStale'))
      return
    }
    const highlights = new Map<string, string[]>()
    for (const target of targets) {
      if (!target.node) continue
      const terms = highlights.get(target.node.id) ?? []
      if (!target.body && target.text) terms.push(target.text)
      highlights.set(target.node.id, terms)
    }
    this.nodeRenderer.setSearch(highlights)
    const first = targets.find(target => target.node)
    if (request.pending && first?.node) {
      for (const target of targets) {
        for (let parent = target.node?.parent; parent; parent = parent.parent) parent.collapsed = false
        // 命中正文时把该节点的正文展开，否则用户只能看到搜索条里的一行摘录
        if (target.body && target.node) target.node.bodyOpen = true
      }
      this.setSelection(first.node.id)
      this.searchFocusId = first.node.id
    }
    this.searchBar.empty()
    this.searchBar.removeClass('is-hidden')
    this.searchBar.createSpan({ text: t(targets.some(x => x.body) ? 'search.body' : 'search.matches', targets.length) })
    const open = this.searchBar.createEl('button', { text: t('search.openNote') })
    open.addEventListener('click', () => {
      const file = this.file
      if (file) void this.host.openSearchResult(this.leaf, file, request.state, this.noteMode).catch(err => this.report(err))
    })
    const close = this.searchBar.createEl('button', { text: t('search.clear') })
    close.addEventListener('click', () => { this.clearSearch(); this.draw(); this.canvas.focus() })
    // Body text is absent from the outline: show the exact source hit without
    // creating editable pseudo-nodes or changing the document/layout geometry.
    const bodyIndex = targets.findIndex(target => target.body)
    if (bodyIndex >= 0) {
      const { content, matches } = request.state.match
      const [from, to] = matches[bodyIndex]!
      const start = Math.max(content.lastIndexOf('\n', Math.max(0, from - 1)) + 1, from - 48)
      const lineEnd = content.indexOf('\n', to)
      const end = Math.min(lineEnd < 0 ? content.length : lineEnd, to + 96)
      const excerpt = this.searchBar.createDiv({ cls: 'om-search-excerpt' })
      excerpt.appendText((start > 0 ? '…' : '') + content.slice(start, from))
      excerpt.createEl('mark', { cls: 'om-search-match', text: content.slice(from, Math.min(to, from + 160)) + (to - from > 160 ? '…' : '') })
      excerpt.appendText(content.slice(to, end) + (end < content.length ? '…' : ''))
    }
    this.draw()
    this.focusSearch()
    request.pending = false
  }

  private focusSearch(): void {
    if (!this.searchFocusId) return
    const box = this.boxes.get(this.searchFocusId)
    if (box && this.canvas.centerOn(box, true, 0.85)) {
      this.searchFocusId = null
      this.needsFit = false
    }
  }

  private resizeCanvas(): void {
    this.initializeViewport()
    this.focusSearch()
  }

  private initializeViewport(): void {
    if (!this.needsFit) return
    const restored = this.initialViewport
      ? this.canvas.restore(this.initialViewport, this.boxes.values()) : this.canvas.fit(this.bounds)
    if (restored) {
      this.needsFit = false
      this.initialViewport = undefined
    }
  }

  private rememberViewport(): void {
    if (!this.file || this.needsFit || !this.boxes.size) return
    const viewport = this.canvas.snapshot()
    if (viewport) this.host.preferences.rememberViewport(this.file.path, viewport)
  }

  private canWriteFile(file: TFile): boolean {
    return !this.host.preferences.isLocked(file.path) && !this.bridge.isReading(file) &&
      !(this.file === file && this.noteMode === 'preview')
  }

  private canEdit(): boolean {
    this.syncLock()
    return !!this.file && !this.locked
  }

  /** 阅读模式：只读、正文全部展开、隐藏每节点的正文开关。 */
  isReadMode(): boolean {
    return this.host.getMindmapViewMode?.() === 'read'
  }

  /** 节点当前应该显示的正文（阅读模式或已展开时才给）。 */
  private bodyTextFor(node: MindNode): string | null {
    if (!this.tree || node.depth === 0) return null
    if (node.id === this.editingBodyId) return bodyTextOf(this.tree, node) || ' '
    if (!hasBody(this.tree, node)) return null
    if (!this.isReadMode() && node.bodyOpen !== true) return null
    return bodyTextOf(this.tree, node)
  }

  private get bodySource(): BodySource {
    return {
      text: (node) => this.bodyTextFor(node),
      open: () => true,
      has: (node) => node.depth > 0 && !!this.tree && hasBody(this.tree, node),
      toggle: !this.isReadMode(),
      query: this.findQuery,
    }
  }

  private syncLock(force = false): void {
    const mode = this.file ? this.bridge.noteMode(this.file) : null
    if (mode) this.noteMode = mode
    const readMode = this.isReadMode()
    const forced = readMode || (!!this.file && this.noteMode === 'preview')
    const locked = forced || (!!this.file && this.host.preferences.isLocked(this.file.path))
    const changed = locked !== this.locked || forced !== this.forcedLock
    this.locked = locked
    this.forcedLock = forced
    if (locked && changed) {
      this.drag.cancel()
      this.cancelSession()
      this.flushPending()
    }
    if (changed || force) {
      this.contentEl.toggleClass('is-locked', locked)
      this.contentEl.toggleClass('is-read-mode', readMode)
      this.toolbar?.setLocked(locked, forced, !!this.file)
      this.toolbar?.setMode(readMode)
      this.toolbar?.setHasBodies(this.hasAnyBody())
    }
  }

  /** 这篇笔记里有没有任何节点带正文（工具栏的正文开关据此显隐）。 */
  private hasAnyBody(): boolean {
    const tree = this.tree
    if (!tree) return false
    for (const node of tree.byId.values()) {
      if (node.depth > 0 && hasBody(tree, node)) return true
    }
    return false
  }

  private toggleLock(): void {
    this.syncLock()
    if (this.file && !this.forcedLock) this.host.preferences.setLocked(this.file.path, !this.locked)
  }

  /** Mode toggles can keep the same file/leaf; observe their public DOM and query getMode(). */
  private observeNoteMode(): void {
    if (typeof MutationObserver === 'undefined') return
    const containers = this.app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === this.file)
      .map(view => view.contentEl)
    if (containers.length === this.modeContainers.length &&
        containers.every((el, index) => el === this.modeContainers[index])) return
    this.modeObserver?.disconnect()
    this.modeContainers = containers
    this.modeObserver = new MutationObserver(() => this.syncLock())
    for (const el of containers) this.modeObserver.observe(el, {
      attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true,
    })
  }

  /**
   * 视图状态里记住当前这篇笔记的路径，以及是不是钉住的。
   *
   * 路径的两个用处：一是「笔记 ⇄ 导图」互转时把目标笔记直接交给新视图（那一刻活动笔记
   * 可能已经不是它了）；二是重启 Obsidian 后导图还停在原来那篇上。
   */
  override getState(): Record<string, unknown> {
    return { ...super.getState(), file: this.file?.path ?? this.pendingPath ?? null, commandMap: this.commandMap, pinned: this.pinned, noteMode: this.noteMode }
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result)
    const { file: path, pinned, noteMode, commandMap } =
      (state as { file?: unknown; pinned?: unknown; noteMode?: unknown; commandMap?: unknown } | null) ?? {}
    if (typeof path !== 'string') return
    this.commandMap = commandMap === true
    this.setPinned(this.commandMap ? this.host.settings.mapMode !== 'follow' : pinned === true)
    if (this.commandMap) this.navigation = false
    if (this.pinned || !this.ready || this.file?.path === path) {
      this.noteMode = noteMode === 'preview' ||
        (noteMode === undefined && this.host.settings.openAs?.[path]?.noteMode === 'preview') ? 'preview' : 'source'
    }
    // setState 早于 onOpen = 视图正在被创建（换形态 / 恢复工作区）。showFile 要用
    // onOpen 里才建起来的 bridge，所以先记下来，等 onOpen 收尾时按取舍规则认领。
    if (!this.ready) {
      this.pendingPath = path
      return
    }
    // 视图已经活着还收到 setState：仍然按同一条取舍规则来，不无条件采信。
    //
    // 【为什么不照办】：跟随型导图这条路上来的路径不一定是「谁明确要求换到这一篇」——工作区被
    // 保存 / 恢复、叶子被搬动、Obsidian 自己回放视图状态时，送来的都是【存档里那一篇】。
    // 无条件采信就会把导图硬拽回上一篇，而且此后没有任何事件来纠正它。钉住的则正好该照办。
    await this.showRestored(path)
    this.syncLock(true)
  }

  /**
   * 钉住 = 这个标签页是「一篇笔记换了形态」，于是也像笔记标签页一样可被导航复用：
   * 在它里面点开别的笔记，会在这个标签页里打开，而不是另开一个；「后退」也能回到导图。
   * 跟随型导图是工具面板，不参与导航。
   */
  async refreshMapMode(): Promise<void> {
    if (this.commandMap) {
      this.pinned = this.host.settings.mapMode !== 'follow'
      this.app.workspace.requestSaveLayout()
    }
    if (this.ready) await this.syncActiveFile()
  }

  private setPinned(pinned: boolean): void {
    this.pinned = pinned
    this.navigation = pinned
  }

  /**
   * 按 follow.ts 的取舍规则处理一条存档路径。
   *
   * @returns 是否定下了一篇并显示了它；false 表示两个候选都没有，由调用方决定怎么兜底
   */
  private async showRestored(path: string): Promise<boolean> {
    const target = fileToShow(
      this.app.vault.getFileByPath(path),
      this.activeMarkdownFile(),
      this.pinned || (!this.commandMap && this.host.settings.lockFile),
    )
    if (target) await this.showFile(target)
    return target !== null
  }

  /**
   * 指名显示某一篇笔记，不看活动笔记是哪一篇。
   *
   * 「笔记 → 导图」转换时由外部调用：那一刻这个叶子刚从 Markdown 变过来，
   * `getActiveFile()` 未必还指着它。
   */
  async showFile(file: TFile): Promise<void> {
    // 已经在显示它、且树也建起来了 → 什么都不用做。
    //
    // 【树还是 null 时不能就这么返回】：路径相同但树是空的（setState 重复到达、
    // 上一次读取被后手判定失效而丢弃）意味着屏幕上是一张永远空着的图。
    // 这种情况往下走，只补读一次文本——不重新 adoptFile，选中与折叠态原封不动。
    if (this.file?.path === file.path) {
      if (this.tree) return
    } else {
      this.adoptFile(file)
      // 先把上一篇的画面清掉：读取是异步的，不清的话这段空隙里还是上一篇的导图
      this.draw()
    }
    const text = await this.bridge.loadText(file)
    if (this.file?.path !== file.path) return // 读取期间又换了一篇，见 syncActiveFile 里的同一道判断
    this.refresh(text)
  }

  /** 导图这一侧的「打开为笔记」（三个点菜单）。 */
  override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source)
    const file = this.file
    if (!file) return
    menu.addItem(item => item.setTitle(t('menu.undo')).setIcon('undo-2')
      .setDisabled(!this.canEdit() || !!this.historyBusy || !!this.session)
      .onClick(() => void this.stepHistory('undo')))
    menu.addItem(item => item.setTitle(t('menu.redo')).setIcon('redo-2')
      .setDisabled(!this.canEdit() || !!this.historyBusy || !!this.session)
      .onClick(() => void this.stepHistory('redo')))
    menu.addItem((item) =>
      item
        .setTitle(t('menu.openAsNote'))
        .setIcon('file-text')
        // 就地换形态：同一个叶子从导图变回 Markdown，不另开标签页。逻辑在 main.ts，
        // 因为它还要忘掉「以导图打开」的记忆，而记忆归插件管。
        .onClick(() => void this.host.openAsNote(this.leaf, file, this.noteMode)),
    )
  }

  override async onOpen(): Promise<void> {
    // NodeRenderer 直接复用 Obsidian 的 renderMath()，因此在第一次画节点之前把 MathJax
    // 准备好。放在「导图视图打开」而不是插件 onload：从不用导图的人不会为它付启动成本。
    try {
      await loadMathJax()
    } catch (err: unknown) {
      // 数学引擎失效不该拖垮整张导图；NodeRenderer 会把公式退回 `$...$` 源码显示。
      console.warn('[outline-mindmap] loadMathJax failed', err)
    }

    const host = this.contentEl
    const win = host.ownerDocument.defaultView ?? window
    this.motion = new LayoutMotion({
      now: () => win.performance.now(),
      request: callback => win.requestAnimationFrame(callback),
      cancel: id => win.cancelAnimationFrame(id),
    })
    this.reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = (): void => { if (this.ready) this.draw() }
    this.reducedMotion.addEventListener('change', onMotionChange)
    this.register(() => this.reducedMotion?.removeEventListener('change', onMotionChange))
    host.empty()
    host.addClass('om-root')

    // 视图刚打开时容器尺寸是 0，适应画布得等 ResizeObserver 报出真实尺寸。
    //
    // 【容器 resize 只重算视口，不自动重排】（M7 交付物）：Canvas 自己缓存新的宽高，
    // 这里除了「还没适应过画布」的那一次之外什么都不做——侧边栏拖宽拖窄是连续事件，
    // 每一帧都重新布局会卡，而且会把用户调好的缩放比例冲掉。
    this.canvas = new Canvas(host, () => this.resizeCanvas(), {
      onUserChange: () => this.rememberViewport(),
      onGestureStart: () => {
        this.motion.finish()
        this.drag.cancel()
        this.cancelSession()
        this.flushPending()
      },
      panNodes: () => { this.syncLock(); return this.locked },
      onMarquee: (box, additive) => this.selectMarquee(box, additive),
    })
    this.empty = host.createDiv({ cls: 'om-empty', text: t('view.empty') })
    // 拖拽时浮在底部的「独立」投放区：拖到这里松手，节点从原来的父子关系里摘出来
    this.floatDock = this.canvas.viewport.createDiv({ cls: 'om-float-dock', text: t('drop.independent') })
    this.searchBar = host.createDiv({ cls: 'om-search-bar is-hidden' })
    this.buildFindBar(host)

    // 工具栏（M7）。浮在画布上层，两种形态（主页面 / 侧边栏）共用同一套按钮。
    this.toolbar = new Toolbar(host, {
      fit: () => this.fitToScreen(),
      zoom: (factor) => this.canvas.zoomBy(factor),
      toggleLock: () => this.toggleLock(),
      openStyle: () => this.openStyle(),
      toggleMode: () => this.toggleMode(),
      toggleBodies: () => this.toggleAllBodies(),
      search: () => this.openFind(),
      undo: () => void this.stepHistory('undo'),
      redo: () => void this.stepHistory('redo'),
      foldLevel: (anchor) => this.showFoldMenu(anchor),
      direction: (anchor) => this.showDirectionMenu(anchor),
      center: () => this.centerView(),
      exportAs: (anchor) => this.showExportMenu(anchor),
      theme: (anchor) => this.showThemeMenu(anchor),
      recite: () => this.toggleRecite(),
      afterAction: () => this.canvas.focus(),
    })
    this.toolbar.setRecite(this.recite)

    // 连线与标注共用一张 SVG：标注（框 / 概要）垫在节点 DOM 层背后
    const svg = this.canvas.content.createSvg('svg', { cls: 'om-svg' })
    this.connectors = new Connectors(svg)
    this.annotations = new Annotations(svg)

    const nodeLayer = this.canvas.content.createDiv({ cls: 'om-nodes' })
    this.nodeRenderer = new NodeRenderer(nodeLayer)
    // 编辑框挂在节点层【外面】：它不该被 nodeLayer 的委托监听器扫到
    this.editor = new InlineEditor(this.canvas.content, {
      onInput: this.onEditorInput,
      onCommit: this.onEditorCommit,
      onCancel: this.onEditorCancel,
    })
    this.bodyEditor = new BodyInlineEditor(this.canvas.content, {
      onCommit: (text) => this.commitBodyEdit(text),
      onCancel: () => this.cancelBodyEdit(),
    })

    // 拖拽（M6）。它自己在节点图层上委托 4 个 pointer 事件，同样与节点数量无关。
    this.drag = new DragController(nodeLayer, {
      canvas: this.canvas,
      tree: () => this.tree,
      boxes: () => this.boxes,
      order: () => this.order,
      enabled: () => this.canEdit() && !this.editor.active && !this.bodyEditor.active && this.session === null && this.tree !== null && !this.historyBusy,
      onDrop: this.onDrop,
      onVisual: (dragging, into) => {
        this.nodeRenderer.setDragVisual(dragging, into)
        this.floatDock.toggleClass('is-visible', dragging.size > 0)
      },
      orientation: () => this.orientation(),
      independentRect: () => (this.floatDock.hasClass('is-visible') ? this.floatDock.getBoundingClientRect() : null),
      onIndependent: (active) => this.floatDock.toggleClass('is-active', active),
      // 带 %%float%% 的独立节点：拖它是挪位置，不是重排结构
      freeDrag: (id) => {
        const node = this.tree?.byId.get(id)
        return Boolean(node?.annotations?.float && this.boxes.has(id))
      },
      onFreeStart: (id) => this.beginFreeDrag(id),
      onFreeMove: (id, dx, dy) => this.previewFreeDrag(id, dx, dy),
      onFreeDrop: (id, dx, dy) => this.commitFreeDrag(id, dx, dy),
      onFreeCancel: () => this.cancelFreeDrag(),
      onFreeRelease: () => this.releaseFreeDrag(),
      scale: () => this.canvas.zoom,
      autoPan: (x, y) => this.autoPan(x, y),
    })

    // 关联线：从节点右缘的小圆点拖到另一个节点，松手即建立一条关联
    // 【cls 只能给一个类名】：Obsidian 的 createSvg 用 classList.add，带空格会直接抛错
    const relSvg = this.canvas.content.createSvg('svg', { cls: 'om-svg' })
    relSvg.addClass('om-rel-layer')
    relSvg.setAttribute('width', '1')
    relSvg.setAttribute('height', '1')
    this.relDrag = new RelationDrag(nodeLayer, relSvg, {
      canvas: this.canvas,
      boxes: () => this.boxes,
      order: () => this.order,
      enabled: () => this.canEdit() && this.session === null && !this.historyBusy,
      onCreate: (fromId, toId) => this.createRelation(fromId, toId),
    })

    // 事件委托：整个图层只有这些监听器，与节点数量无关（第 2 章）
    this.registerDomEvent(nodeLayer, 'click', this.onLayerClick)
    this.registerDomEvent(this.canvas.viewport, 'contextmenu', this.onNodeMenu)
    // 移动端没有右键：长按节点 / 空白 500ms 弹同一份菜单
    this.registerDomEvent(this.canvas.viewport, 'pointerdown', this.onLongPressDown)
    this.registerDomEvent(this.canvas.viewport, 'pointermove', this.onLongPressMove)
    this.registerDomEvent(this.canvas.viewport, 'pointerup', this.onLongPressEnd)
    this.registerDomEvent(this.canvas.viewport, 'pointercancel', this.onLongPressEnd)
    this.registerDomEvent(this.canvas.viewport, 'click', this.onAnnotationClick)
    this.registerDomEvent(this.canvas.viewport, 'dblclick', this.onDoubleClick)
    this.registerDomEvent(this.canvas.viewport, 'keydown', this.onKeyDown)
    this.registerDomEvent(this.canvas.viewport, 'pointerdown', () => this.motion.finish(), true)

    this.bridge = new DocumentBridge(this.app, this.onDocumentChange, this.host.fileHistory,
      file => this.canWriteFile(file))
    // 交给 this（ItemView 也是 Component）托管，视图关闭时监听自动解绑
    this.bridge.start(this)
    this.unsubscribePreferences = this.host.preferences.subscribe(() => this.syncLock(true))
    this.syncLock(true)

    // 样式变了就重绘。样式窗口拖滑块时也走这条 → 实时预览（M8）。
    // 变的可能是别篇笔记的单篇样式，跟自己无关时 resolveStyle 返回 false，一帧都不浪费。
    this.unsubscribeStyle = this.host.styles.subscribe(() => {
      this.styleChanged()
    })
    // 阅读 / 编辑模式是全局状态：别的标签页切换了，这一页也要跟着变
    this.unsubscribeViewMode = (this.host as unknown as {
      onMindmapViewModeChange?: (cb: (mode: 'edit' | 'read') => void) => () => void
    }).onMindmapViewModeChange?.(() => {
      this.cancelBodyEdit()
      this.syncLock(true)
      this.draw()
    }) ?? null
    this.resolveStyle()

    // 【用事件自带的载荷判定】，不回头问 getActiveFile()：活动叶子不是笔记（比如导图自己）时，
    // Obsidian 会把「活动笔记」回退成别的标签页里最近活动的那篇，点一下导图就可能把图切走。
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.observeNoteMode()
        this.syncLock()
        void this.syncActiveFile(false, 'file-open', file)
      }),
    )
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        this.observeNoteMode()
        this.syncLock()
        const view = leaf?.view
        void this.syncActiveFile(false, 'leaf-change', view instanceof FileView ? view.file : null)
      }),
    )
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.observeNoteMode()
      this.syncLock()
    }))
    // 正在显示的这篇被删了。syncActiveFile 现在会忽略瞬时的「没有活动笔记」，
    // 所以这一路必须显式收尾，否则屏幕上会留着一张已经不存在的笔记的导图。
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        if (!this.file || (this.file.path !== f.path && !this.file.path.startsWith(`${f.path}/`))) return
        this.adoptFile(null)
        this.draw()
        const active = this.activeMarkdownFile()
        if (!this.pinned && (this.commandMap || !this.host.settings.lockFile) && active &&
            active.path !== f.path && !active.path.startsWith(`${f.path}/`)) {
          void this.syncActiveFile(false, 'delete', active)
        }
      }),
    )
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        // 换主题 / 改字号 → 测量全部作废
        this.font = null
        clearMeasureCache()
        this.draw()
      }),
    )

    this.ready = true

    // 该显示哪一篇：钉住的照办，否则活动笔记优先、存档路径只是回退。理由见 follow.ts，
    // 一句话是「后台的跟随型导图会被 Obsidian 整个卸载，醒来时它存的那一篇早就过时了」。
    const pending = this.pendingPath
    this.pendingPath = null
    const shown = pending !== null && (await this.showRestored(pending))
    if (!shown) await this.syncActiveFile(true, 'onOpen')
  }

  override async onClose(): Promise<void> {
    this.modeObserver?.disconnect()
    this.modeObserver = null
    this.modeContainers = []
    this.unsubscribePreferences?.()
    this.unsubscribePreferences = null
    this.host.preferences.flush()
    this.motion?.reset()
    this.clearSearch()
    // 关视图时未提交的编辑一律作废：这时候再往文件里写字，用户根本看不见
    this.cancelSession()
    this.cancelBodyEdit()
    this.clearLongPress()
    this.unsubscribeStyle?.()
    this.unsubscribeStyle = null
    this.unsubscribeViewMode?.()
    this.unsubscribeViewMode = null
    this.toolbar.destroy()
    this.drag.destroy()
    this.relDrag.destroy()
    this.editor.destroy()
    this.bodyEditor.destroy()
    this.bridge.dispose()
    this.nodeRenderer.destroy()
    this.connectors.destroy()
    this.annotations.destroy()
    this.canvas.destroy()
    this.tree = null
    this.boxes = new Map()
    this.order = []
    this.selection.clear()
    this.focusId = null
    this.file = null
    this.ready = false
    this.pendingPath = null
    // 容器里的 DOM 一次清干净（M10 验收：开关视图 50 次不涨内存）。
    // 各个部件的 destroy 只负责自己挂上去的那些元素，剩下的空状态、图层容器由这里收尾。
    this.contentEl.empty()
  }

  /**
   * 视图尺寸变化时的一道兜底：顺手和活动笔记对一次表。
   *
   * 「导图没跟着笔记切换」还有一类成因是【事件根本没送到】：视图被折叠 / 卸载期间
   * 换过笔记，重新露出来时 Obsidian 不会补发 file-open，也就没有任何后续事件来纠正它。
   * 而「重新变得可见」必定伴随一次 resize，正好借它对表。
   *
   * 【这不是轮询】：`syncActiveFile` 头一行就是引用相等比较，笔记没换时它一个字都不做，
   * 更碰不到渲染路径。拖侧边栏宽度会连着触发几十次，代价也只是几十次指针比较。
   */
  override onResize(): void {
    // 视图还在 onOpen 里（MathJax / DOM 尚未备齐）时先不处理：那时 bridge 还没有，
    // 贸然同步会把「换笔记」走到一半就抛错，整张导图停在半初始化状态。
    if (!this.ready || !this.bridge) return
    void this.syncActiveFile(false, 'resize')
  }

  /**
   * 「跟随自检」命令的报告（命令面板里那一条）。
   *
   * 报的是事实，不是结论。三种成因在留痕上各自长什么样：
   * - 切笔记时留痕【一条都没多】→ 事件没送到这个视图（视图被卸载过、或被别的东西吃了）
   * - 留痕里「看到」的还是旧那篇 → `getActiveFile()` 给的是过时的
   * - 「看到」的是新那篇却写着没换 → 被某条规则挡下了，结论那一栏会写是哪条
   */
  diagnostics(): string {
    const ws = this.app.workspace
    const active = ws.getActiveFile()
    const alive = Math.round((Date.now() - this.bornAt) / 1000)
    return [
      t(
        'diag.title',
        this.leaf.getRoot() === ws.rootSplit ? t('diag.mainArea') : t('diag.sidebar'),
        alive,
      ),
      t('diag.activeNote', active?.path ?? t('diag.none')),
      t('diag.showing', (this.file?.path ?? t('diag.none')) + (this.tree ? '' : t('diag.treeEmpty'))),
      t(
        'diag.switches',
        this.host.settings.lockFile ? t('diag.on') : t('diag.off'),
        this.host.settings.clickToJump ? t('diag.on') : t('diag.off'),
      ),
      t('diag.pinned', this.pinned ? t('diag.on') : t('diag.off')),
      t('diag.trail', this.trail.length),
      ...(this.trail.length === 0 ? [t('diag.noEvents')] : this.trail.map((s) => `    ${s}`)),
    ].join('\n')
  }

  /**
   * 记一次「该不该换笔记」的判定。留痕带上来源与当时看到的活动笔记，
   * 「没送到」和「送到了但看到的是旧的」才分得开。
   */
  private note(source: string, active: TFile | null, outcome: string): void {
    const at = ((Date.now() - this.bornAt) / 1000).toFixed(1)
    this.trail.push(`+${at}s ${source} → ${active?.basename ?? t('diag.none')} → ${outcome}`)
    if (this.trail.length > 16) this.trail.shift()
  }

  /**
   * 适应画布。缩放比例按【当前容器尺寸】算——Canvas 的宽高来自 ResizeObserver，
   * 因此侧边栏被拖到多窄都是对的（M7 交付物）。
   *
   * 手动点「适应画布」是平滑移过去的（M10，受「优雅动画」开关控制）；
   * 打开笔记时的那次自动适应不带动画，见 draw() 末尾。
   */
  fitToScreen(): void {
    if (this.canvas.fit(this.bounds, true)) {
      this.needsFit = false
      this.initialViewport = undefined
      this.rememberViewport()
    }
  }

  /**
   * 把某个节点连同它当前可见的后代摆到屏幕正中（M10 交付物）。
   *
   * 展开时子树刚长出来 → 居中的是长大后的整块；折叠时后代没有 Box →
   * `subtreeBounds` 自然收缩成节点自己，视野跟着一起收。
   *
   * @returns 目标不存在（没选中、已被藏起来）时返回 false，调用方可以另作打算
   */
  private centerSubtree(id: string | null): boolean {
    const node = id === null ? undefined : this.tree?.byId.get(id)
    if (!node) return false
    const box = subtreeBounds(node, this.boxes)
    if (!box) return false
    this.canvas.centerOn(box, true)
    return true
  }

  /**
   * 展开 / 折叠一个节点，并让视野跟着一起展开 / 收起（M10）。
   *
   * 折叠按钮、方向键的折叠/展开、拖拽落进折叠节点，都该是同一种手感，
   * 所以统一走这一条。
   */
  private setCollapsed(node: MindNode, collapsed: boolean): void {
    node.collapsed = collapsed
    this.draw()
    this.centerSubtree(node.id)
    this.rememberViewport()
  }

  /**
   * 取当前笔记该用的样式，落到 CSS class 与测量上（M8）。
   *
   * StyleStore 从不就地改样式对象（应用与预览都是新对象），所以比一次引用就够，
   * 不必逐字段比。
   *
   * @returns 样式是否真的变了。没变就别重绘——预览时每拖一格滑块，所有导图视图都会被叫醒
   */
  private resolveStyle(): boolean {
    const next = this.host.styles.styleFor(this.file?.path ?? null)
    const prev = this.style
    const changed = prev !== next
    const root = this.contentEl
    if (changed) root.removeClass(`om-shape-${prev.shape}`, `om-scheme-${prev.scheme}`)
    // 首次调用时 prev 还是默认样式、class 一个都没挂上，所以这里无条件加一次
    root.addClass(`om-shape-${next.shape}`, `om-scheme-${next.scheme}`)
    // 多彩标题：层级 class 常年在节点上，着不着色由根上的这一个开关说了算
    root.toggleClass('om-level-colors', next.colorByLevel)
    if (prev.background || next.background) root.style.setProperty('--om-custom-background', next.background ?? '')
    if (prev.edgeColor || next.edgeColor) root.style.setProperty('--om-custom-edge', next.edgeColor ?? '')
    for (let i = 0; (prev.levelColors || next.levelColors) && i < 6; i++) {
      const color = next.levelColors?.[i]
      const rgb = color?.slice(1).match(/../g)?.map(channel => parseInt(channel, 16)).join(', ')
      root.style.setProperty('--om-custom-level-' + (i + 1), rgb ?? '')
    }
    // 字号缩放变了 → 之前量出来的每一个宽高都作废
    if (changed && prev.fontScale !== next.fontScale) this.font = null
    this.style = next
    this.direction = next.direction
    return changed
  }

  private styleChanged(): void {
    const preview = this.host.styles.previewPath() === (this.file?.path ?? null)
    const current = !this.needsFit && this.boxes.size ? this.canvas.snapshot() : undefined
    if (preview && !this.previewingStyle) {
      this.styleViewport = current
      this.previewingStyle = true
    }
    // Reuse the pre-preview anchor throughout the draft and on Cancel. Coordinates
    // valid in the new layout stay put; otherwise restore chooses a visible fallback.
    const anchor = this.previewingStyle ? this.styleViewport : current
    if (this.resolveStyle()) {
      this.draw()
      if (anchor && this.canvas.restore(anchor, this.boxes.values())) {
        const restored = this.canvas.snapshot()
        if (restored && current && (restored.x !== current.x || restored.y !== current.y)) this.motion.finish()
      }
    }
    if (!preview) {
      this.previewingStyle = false
      this.styleViewport = undefined
    }
  }

  /** 打开样式窗口（M8）。没有笔记时窗口里只有「应用全局设置」可按。 */
  private openStyle(): void {
    const source = this.file
    new StyleModal(
      this.app,
      this.host.styles,
      this.file?.path ?? null,
      this.file?.basename ?? null,
      source ? async (format, background, scale, page, padding, expandAll) => {
        let exportLayer: HTMLElement | undefined
        try {
          if (this.file !== source || !this.ready) throw new Error('The source map changed')
          this.motion.finish()
          if (expandAll && this.tree) {
            const fullTree = parse(joinLines(this.tree.lines, this.tree.eol), this.parseOptions())
            const boxes = layout(fullTree, this.layoutOptions())
            const nodes = visibleNodes(fullTree)
            const bounds = boundsOf(boxes)
            exportLayer = this.contentEl.createDiv({ cls: 'om-content om-export-layer' })
            const svg = exportLayer.createSvg('svg', { cls: 'om-svg' })
            const connectors = new Connectors(svg)
            connectors.render(nodes, boxes, this.style.branch, bounds.x + bounds.w, bounds.y + bounds.h, this.orientation())
            new Annotations(svg).render(nodes, boxes, this.orientation(), this.currentFont().size)
            const renderer = new NodeRenderer(exportLayer.createDiv({ cls: 'om-nodes' }))
            renderer.render(nodes, boxes, new Set(), rootSide(this.direction))
          }
          await exportMap(exportLayer ?? this.canvas.content, this.file?.basename ?? 'mindmap', format,
            background === 'white' || (format === 'pdf' && background === 'transparent') ? '#fff'
              : background === 'transparent' ? '' : this.style.background ?? getComputedStyle(this.contentEl)
                .getPropertyValue('--background-primary').trim(), scale, page, padding)
        } catch (error) {
          console.error(error)
          new Notice(t(error instanceof ExportSizeError ? 'style.exportTooLarge' : 'style.exportFailed'))
        } finally {
          exportLayer?.remove()
        }
      } : undefined,
      () => ({ width: Math.ceil(this.bounds.w), height: Math.ceil(this.bounds.h) }),
    ).open()
  }

  /** 解析 / 序列化选项。每次现取，改设置后下一次编辑立即生效。 */
  private parseOptions(): ParseOptions {
    return {
      strictLineBreak: this.host.settings.strictLineBreak,
      listNodes: this.host.settings.listNodes,
      orderedListNodes: this.host.settings.orderedListNodes,
      deepListMarker: this.host.settings.listNodes && this.host.settings.orderedListNodes
        ? this.host.settings.deepListMarker : this.host.settings.orderedListNodes ? '1.' : '-',
    }
  }

  // ── 数据 ────────────────────────────────────────────────────

  /**
   * 换到另一篇笔记（或空）时要重置的那一整套状态。
   *
   * syncActiveFile 与 showFile 共用这一份：两处各抄一遍的话，往后加一个字段
   * 只改了一边，就会出现「跟着活动笔记切换是干净的、手动指名切换却残留上一篇」这种鬼故事。
   */
  private adoptFile(next: TFile | null): void {
    this.canvas.cancelGesture()
    this.drag.cancel()
    this.motion?.reset()
    if (this.search?.path !== next?.path) this.clearSearch()
    // 换笔记时把就地搜索也收起来：旧关键词对新笔记没有意义
    if (this.findBar) {
      this.findBar.addClass('is-hidden')
      this.findInput.value = ''
      this.findCount.setText('')
      this.findQuery = ''
      this.findHits = []
      this.findAt = 0
    }
    this.cancelSession()
    this.file = next
    this.styleViewport = undefined
    this.previewingStyle = false
    if (!this.pinned) this.noteMode = 'source'
    this.initialViewport = next ? this.host.preferences.viewportFor(next.path) : undefined
    this.tree = null // 切换笔记即重置折叠态（第 4.5 节的 v1 决策）
    this.setSelection(null)
    this.pendingText = null
    this.needsFit = true
    this.bridge.setFile(next)
    // 换笔记就换样式：这一篇可能有自己的单篇样式（M8）
    this.resolveStyle()
    this.observeNoteMode()
    this.syncLock(true)
    // 刷新标签页标题。updateHeader 不在公开类型里，取不到就算了——标题旧一点不影响功能。
    ;(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.()
  }

  /** 当前活动笔记，非 Markdown 一律当没有。 */
  private activeMarkdownFile(): TFile | null {
    return markdownOnly(this.app.workspace.getActiveFile())
  }

  /**
   * @param force 视图刚打开时即使没有活动笔记也要走一遍，好把空状态画出来。
   * @param source 是谁叫的。只用于自检留痕，见 `note`。
   * @param candidate 事件自带的那篇（`file-open` 的参数、`active-leaf-change` 里叶子的文件）。
   *   不传才去问 `getActiveFile()`——只有没有事件载荷可用的兜底路径（打开、resize、删除）这么做。
   */
  private async syncActiveFile(
    force = false,
    source = '内部',
    candidate?: TFile | null,
  ): Promise<void> {
    // 视图还没初始化完（bridge 未就绪）时没有「换笔记」可言，等 onOpen 末尾那次首次同步
    if (!this.bridge) return
    const next = candidate === undefined ? this.activeMarkdownFile() : markdownOnly(candidate)
    // 钉住的导图（「打开为导图」换出来的）与全局「固定显示一篇笔记」（M7 设置项，键名仍是 lockFile）：
    // 都不跟着活动笔记走。force 那次是视图刚打开时的首次同步，必须放行——否则新开一个导图会是空的。
    if ((this.pinned || (!this.commandMap && this.host.settings.lockFile)) && this.file && !force) {
      this.note(source, next, t('trail.blockedByPin'))
      return
    }

    // 【瞬时的「没有活动笔记」不算换笔记】。切标签页、点一下侧边栏的空隙里，
    // getActiveFile() 会短暂地返回 null；照单全收就是把整张图清空重画一遍——
    // 折叠态和视野一起没，用户看到的是闪一下白。
    // 真正需要清空的只有「这篇被删了」，那一路由 vault 的 delete 监听带 force 进来。
    if (!next && !force) {
      this.note(source, next, t('trail.noActive'))
      return
    }
    if (next === this.file && !force) {
      this.note(source, next, t('trail.sameNote'))
      return
    }

    this.note(source, next, t('trail.switched', next?.basename ?? t('diag.none')))
    this.adoptFile(next)

    if (!next) {
      this.draw()
      return
    }

    // 先把上一篇的画面清掉：读取是异步的，不清的话这段空隙里屏幕上还是上一篇的导图
    this.draw()

    const text = await this.bridge.loadText(next)
    // 【读取期间可能又换了一篇】。A→B 快速切换时，若 A 的读取比 B 慢，
    // A 的后手回来会把 A 的文本刷进 B 的视图，画面就永久停在上一篇上（不会自愈）。
    // 身份对不上就直接丢弃——B 自己那一次同步会把正确的内容刷进来。
    if (this.file !== next) return
    this.refresh(text)
  }

  private readonly onDocumentChange = (change: DocumentChange): void => {
    if (!this.file || change.file.path !== this.file.path) return
    // 自己写的那份内容早在写之前就同步刷过了，回声一律丢弃
    if (change.selfOriginated) return
    // 编辑期间来的外部变更先攒着：现在刷会把草稿和光标一起冲掉
    if (this.session) {
      this.pendingText = change.text
      return
    }
    this.refresh(change.text)
  }

  private refresh(text: string): void {
    this.tree = reconcile(this.tree, parse(text, this.parseOptions()))
    // 被别处删掉的节点不能继续留在选中集合里，否则删除/拖拽会拿着不存在的 id 去生成 plan
    const byId = this.tree.byId
    for (const id of [...this.selection]) if (!byId.has(id)) this.selection.delete(id)
    if (this.focusId !== null && !byId.has(this.focusId)) {
      this.focusId = null
      if (this.search) this.search.pending = true
    }
    if (this.search && !this.search.pending && !searchTargets(this.tree, this.search.state)) this.clearSearch()
    if (this.search) this.applySearch()
    else this.draw()
  }

  /** 编辑结束后补上编辑期间被挡下的外部变更。 */
  private flushPending(): void {
    const text = this.pendingText
    if (text === null || this.session) return
    this.pendingText = null
    this.refresh(text)
  }

  /**
   * 设置里的解析选项变了（「把列表项显示为节点」）：按新规则重新解析当前笔记。
   * 折叠态与节点 id 由 reconcile 保住；正在编辑时不开进来（开关在设置页，点它时编辑框已收起）。
   */
  async reparse(): Promise<void> {
    const file = this.file
    if (!file) return
    const text = await this.bridge.readText(file)
    if (this.file?.path !== file.path) return // 读取期间换了笔记，那一路自己会刷
    this.refresh(text)
  }

  // ── 渲染 ────────────────────────────────────────────────────

  private draw(): void {
    const tree = this.tree
    const hasContent = tree !== null && tree.root.children.length > 0
    this.empty.toggleClass('is-visible', !hasContent)
    const motionAllowed = this.host.settings.gracefulAnimation && !this.reducedMotion?.matches
    if (!tree || !hasContent) {
      this.motion.reset()
      this.nodeRenderer.render([], new Map(), this.selection, rootSide(this.direction), this.bodySource)
      this.connectors.render([], new Map(), this.style.branch, 0, 0, this.orientation())
      this.annotations.render([], new Map(), this.orientation(), this.currentFont().size)
      this.boxes = new Map()
      this.metrics.clear()
      this.order = []
      this.bounds = { x: 0, y: 0, w: 0, h: 0 }
      return
    }

    this.metrics.clear()
    const boxes = layout(tree, this.layoutOptions())
    const nodes = visibleNodes(tree)
    const animated = motionAllowed && nodes.length <= MOTION_NODE_LIMIT
    this.canvas.setAnimated(animated)
    this.boxes = boxes
    this.order = nodes.map((n) => n.id)
    this.bounds = boundsOf(boxes)
    // Keep logical hit targets at their final positions. Pointer interaction finishes
    // the short transition before hit-testing, so edits never use intermediate geometry.
    this.motion.update(boxes, animated && !this.needsFit && !this.session && !this.drag.active, frame => {
      this.nodeRenderer.render(nodes, frame, this.selection, rootSide(this.direction), this.bodySource)
      const bounds = boundsOf(frame)
      this.connectors.render(nodes, frame, this.style.branch, bounds.x + bounds.w, bounds.y + bounds.h, this.orientation())
      this.annotations.render(nodes, frame, this.orientation(), this.currentFont().size)
    })

    this.toolbar.setHasBodies(this.hasAnyBody())
    // 阅读模式下备注本来就是全展开的，按钮显示成「已打开」
    this.toolbar.setBodiesOpen(this.isReadMode() || this.allBodiesOpen())
    this.initializeViewport()
  }

  /** 当前样式对应的布局参数。draw 与性能自检共用，免得两处各写一份。 */
  private layoutOptions(): LayoutOptions {
    const font = this.currentFont()
    return {
      ...DEFAULT_LAYOUT,
      direction: this.direction,
      structure: this.style.structure ?? 'mindmap',
      hGap: this.style.hGap,
      vGap: this.style.vGap,
      // 根之间的距离跟着纵向间距走，但不小于默认值：纵向间距调大之后，
      // 两棵根挨得比同一棵树里的兄弟还近，看上去就像它们是一家的
      rootGap: Math.max(DEFAULT_LAYOUT.rootGap, this.style.vGap * 2),
      measure: (node) => {
        const body = this.bodyTextFor(node)
        const metrics = measureNode(node.text, font, node.marker, body)
        this.metrics.set(node.id, metrics)
        return metrics
      },
    }
  }

  /** 连线与拖拽落点用的方向。向下组织图按竖直方向判定。 */
  private orientation(): 'h' | 'v' {
    return this.style?.structure === 'org-down' ? 'v' : 'h'
  }

  /** 字体只从 CSS 变量读一次，之后缓存；css-change 与字号缩放变化时作废。 */
  private currentFont(): FontSpec {
    if (this.font) return this.font
    const font = readFont(this.contentEl, this.style.fontScale)
    // DOM 必须用与测量完全相同的字体，否则折行结果对不上
    this.contentEl.setCssProps({
      '--om-font-family': font.family,
      '--om-font-size': `${font.size}px`,
      '--om-line-height': `${font.lineHeight}px`,
      // 正文的像素字号与行高必须和 measure.ts 用的一模一样，否则多行正文会累积误差
      '--om-body-font-size': `${bodyFont(font).size}px`,
      '--om-body-line-height': `${bodyFont(font).lineHeight}px`,
      // 折叠按钮跟着字号缩放走（M11）。命中区是 CSS 里另外撑出来的，与这个直径无关
      '--om-toggle-size': `${toggleSize(this.style.fontScale)}px`,
      // 任务复选框的尺寸必须与 measure.ts 的 taskBox() 完全一致，否则节点宽度会差一截
      '--om-task-size': `${taskBox(font).size}px`,
      '--om-task-gap': `${taskBox(font).gap}px`,
    })
    this.font = font
    return font
  }

  /**
   * 性能自检（M10）。命令面板里的「导图性能自检」调它，结果直接弹给用户。
   *
   * 为什么要做在插件里：M10 那条「首次渲染 > 500ms 就上视口虚拟化」是个【条件】，
   * 而 DOM 的耗时在 node 环境的单测里根本量不到——只有在真实 Obsidian、真实主题、
   * 真实机器上跑一次，这个条件才有答案。纯计算那一段由 src/tests/perf.test.ts 守着。
   *
   * 「冷渲染」= 丢掉整个 DOM 复用池重建一遍，等价于第一次打开这篇笔记；
   * 每次测量后都读一次 offsetHeight，把浏览器的样式计算与排版一起算进来
   * （绘制那一步在主线程之外，量不到，报告里如实说明）。
   */
  perfReport(): string {
    const tree = this.tree
    if (!tree || tree.root.children.length === 0) return t('perf.noNote')

    const nodes = visibleNodes(tree).length
    const t0 = performance.now()
    layout(tree, this.layoutOptions())
    const layoutMs = performance.now() - t0

    this.nodeRenderer.destroy()
    const t1 = performance.now()
    this.draw()
    void this.canvas.viewport.offsetHeight
    const coldMs = performance.now() - t1

    const t2 = performance.now()
    this.draw()
    void this.canvas.viewport.offsetHeight
    const warmMs = performance.now() - t2

    const ms = (v: number): string => `${v.toFixed(1)}ms`
    return [
      t('perf.title', nodes),
      t('perf.layout', ms(layoutMs)),
      t('perf.cold', ms(coldMs)),
      t('perf.warm', ms(warmMs)),
      coldMs > 500 ? t('perf.needsVirtualize') : t('perf.ok'),
    ].join('\n')
  }

  /** 当前正在显示的笔记路径（供外部「定位到导图」判断是不是同一篇）。 */
  get filePath(): string | null {
    return this.file?.path ?? null
  }

  /**
   * 定位到笔记的某一行：展开所有祖先、选中对应节点并居中。
   * @returns 找到并定位了返回 true
   */
  revealLine(line: number): boolean {
    const tree = this.tree
    if (!tree) return false
    let target: MindNode | null = null
    for (const node of tree.byId.values()) {
      if (node.depth > 0 && node.titleLine === line) {
        target = node
        break
      }
    }
    if (!target) return false
    for (let p = target.parent; p; p = p.parent) p.collapsed = false
    this.setSelection(target.id)
    this.draw()
    const box = this.boxes.get(target.id)
    if (box) this.canvas.centerOn(box, true)
    return true
  }

  /** 把某个节点带进视野。最小平移，留 40px 边距（M5 交付物）。 */
  private reveal(id: string | null): void {
    const box = id === null ? undefined : this.boxes.get(id)
    if (box) this.canvas.ensureVisible(box)
    this.rememberViewport()
  }

  // ── 鼠标 ────────────────────────────────────────────────────

  /** 点外框 / 概要：打开对应节点的标注编辑。 */
  private readonly onAnnotationClick = (e: MouseEvent): void => {
    const el = e.target instanceof Element ? e.target.closest<Element>('[data-anno]') : null
    const spec = el?.getAttribute('data-anno')
    if (!spec) return
    const [kind, id, extra] = spec.split(':')
    if ((kind === 'box' || kind === 'summary') && id && this.tree?.byId.has(id)) {
      e.preventDefault()
      e.stopPropagation()
      this.openAnnotationForm(id, kind)
      return
    }
    if (kind === 'rel' && id !== undefined && extra !== undefined) {
      const index = Number.parseInt(extra, 10)
      if (!Number.isInteger(index)) return
      e.preventDefault()
      e.stopPropagation()
      this.editRelationText(id, index)
    }
  }

  private readonly onLayerClick = (e: MouseEvent): void => {
    // 拖拽松手后浏览器还会补一个 click，不吃掉它就会顺手跳转到笔记里去
    const dragged = this.drag.consumeClick()
    const linked = this.relDrag.consumeClick()
    if (dragged || linked) return
    // 长按刚弹过菜单：松手时浏览器补的那次 click 不该再选中 / 跳转
    if (Date.now() - this.longPressAt < LONG_PRESS_GUARD) return

    const target = e.target as HTMLElement
    // 任务复选框：点一下切换 [ ] ⇄ [x]，不触发选中与跳转
    const taskEl = target.closest<HTMLElement>('.om-task')
    if (taskEl) {
      const nodeId = taskEl.closest<HTMLElement>('.om-node')?.dataset['nodeId']
      if (nodeId) this.toggleTask(nodeId)
      return
    }
    // 背诵模式：点遮住的高亮只揭开 / 盖回，不触发选中与跳转
    if (this.recite) {
      const mark = target.closest('mark:not(.om-search-match)')
      if (mark) {
        mark.classList.toggle('is-revealed')
        return
      }
    }
    const host = target.closest<HTMLElement>('.om-node')
    const id = host?.dataset['nodeId']
    if (!id || !this.tree) return
    const node = this.tree.byId.get(id)
    if (!node) return

    if (target.closest('.om-toggle')) {
      if (node.children.length === 0) return
      this.setCollapsed(node, !node.collapsed)
      return
    }
    // 正文开关：只动视图状态，不碰文件
    if (target.closest('.om-body-toggle')) {
      node.bodyOpen = node.bodyOpen !== true
      this.draw()
      this.canvas.focus()
      return
    }

    // Ctrl/⌘ + 左键 = 加选 / 减选（M6，为批量删除服务）。加选时不跳转：
    // 正在攒一批要删的节点，编辑器却在一路乱滚，很吵。
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelection(id)
      this.draw()
      this.canvas.focus()
      return
    }

    this.select(id)
    // 焦点必须留在导图上，否则后面的快捷键全废
    this.canvas.focus()
    if (this.host.settings.clickToJump && this.file && !this.session) {
      this.jumpTo(node.titleLine)
    }
  }

  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.editor.active || this.bodyEditor.active) return
    const target = e.target as HTMLElement
    // 双击正文 = 编辑这一块正文（阅读模式下不响应）
    const bodyHost = target.closest<HTMLElement>('.om-node-body')
    if (bodyHost) {
      if (!this.canEdit()) return
      const id = bodyHost.closest<HTMLElement>('.om-node')?.dataset['nodeId']
      if (id) this.beginBodyEdit(id)
      return
    }
    const id = target.closest('.om-node')?.getAttribute('data-node-id')
    if (id) {
      // 双击节点 = 编辑它（与 F2 同义）
      this.beginRename(id)
      return
    }
    if (target.closest('.om-editor')) return
    // 双击空白 = 新建自由根，空笔记也能用
    this.beginDraft({ type: 'root' })
  }

  /**
   * 跳转到笔记对应行。
   *
   * 【只滚已经露着的编辑器】：笔记没开、或压在别的标签页后面时，这一下什么都不做。
   * 于是「打开为导图」天然就是纯导图模式——那个叶子里已经没有编辑器了，点节点只选中。
   * 不抢焦点、不新开标签页，细节见 DocumentBridge.revealLine。
   */
  private jumpTo(line: number): void {
    const file = this.file
    if (!file || line < 0) return
    this.bridge.revealLine(file, line)
  }

  // ── 键盘（M5）───────────────────────────────────────────────

  /**
   * 导图的快捷键。编辑态下的按键由 InlineEditor 自己吃掉并 stopPropagation，
   * 传不到这里；`editor.active` 那一行是兜底。
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.motion?.finish()
    if (this.editor.active || this.bodyEditor?.active || e.isComposing) return
    // 拖拽中按 Esc = 放弃这次拖拽，文件一个字都不写
    if (e.key === 'Escape' && this.drag.active) {
      e.preventDefault()
      this.drag.cancel()
      return
    }
    const mod = e.ctrlKey || e.metaKey

    if (mod && !e.altKey && (e.key.toLowerCase() === 'z' ||
        (!e.shiftKey && e.key.toLowerCase() === 'y'))) {
      e.preventDefault()
      e.stopPropagation()
      void this.stepHistory(e.shiftKey || e.key.toLowerCase() === 'y' ? 'redo' : 'undo')
      return
    }
    if (this.historyBusy) { e.preventDefault(); return }
    if (mod || e.altKey) return

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault()
        this.move(this.arrowToNav(e.key))
        break
      case 'Enter':
        e.preventDefault()
        this.startSibling()
        break
      case 'Tab':
        e.preventDefault()
        this.startChild()
        break
      case 'F2':
        e.preventDefault()
        if (this.focusId) this.beginRename(this.focusId)
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        this.removeSelected()
        break
      default:
        break
    }
  }

  /**
   * 方向键 → 导航意图。
   *
   * 水平方向按【主选中节点所在的那一侧】解释：节点朝左生长时，← 才是「进到子节点里去」、
   * → 是「回到父节点」。否则在分支向左的导图里按 →，选中会看着往左跑，手感是反的。
   *
   * 翻转只发生在这一层：`navigate()` 里的 'right' 恒定表示「往深处走」、'left' 恒定表示
   * 「往回收」，core 不需要知道屏幕上哪边是哪边。
   */
  private arrowToNav(key: string): NavDirection {
    const dir = arrowToDirection(key)
    if (dir !== 'left' && dir !== 'right') return dir
    if (this.focusSide() === 'right') return dir
    return dir === 'left' ? 'right' : 'left'
  }

  /** 主选中节点朝哪一侧生长。没有选中 / 还没布局时按整体方向算。 */
  private focusSide(): NodeSide {
    const fallback = rootSide(this.direction)
    const id = this.focusId
    if (id === null) return fallback
    const node = this.tree?.byId.get(id)
    const box = this.boxes.get(id)
    if (!node || !box) return fallback
    return sideOf(box, node.parent ? this.boxes.get(node.parent.id) : undefined, fallback)
  }

  private move(dir: NavDirection): void {
    const tree = this.tree
    if (!tree) return
    if (!this.focusId) {
      const first = tree.root.children[0]
      if (first) this.select(first.id)
      return
    }
    const action = navigate(tree, this.focusId, dir)
    if (!action) return
    if (action.type === 'select') {
      this.select(action.id)
      return
    }
    const node = tree.byId.get(action.id)
    if (!node) return
    this.setCollapsed(node, action.type === 'collapse')
  }

  private select(id: string): void {
    this.setSelection(id)
    this.draw()
    this.reveal(id)
  }

  /** 单选：清掉其余的。`null` = 什么都不选。 */
  private setSelection(id: string | null): void {
    this.selection.clear()
    if (id !== null) this.selection.add(id)
    this.focusId = id
  }

  /** Ctrl+左键：加选 / 减选。减掉主选中时，主选中让给集合里剩下的最后一个。 */
  private toggleSelection(id: string): void {
    if (this.selection.delete(id)) {
      if (this.focusId === id) {
        let last: string | null = null
        for (const rest of this.selection) last = rest
        this.focusId = last
      }
      return
    }
    this.selection.add(id)
    this.focusId = id
  }

  /** 框选：矩形与节点包围盒相交即选中。`box` 为 null = 单击空白，清空选择。 */
  private selectMarquee(box: Box | null, additive: boolean): void {
    const tree = this.tree
    if (!tree) return
    if (!box) {
      if (!additive && this.selection.size > 0) {
        this.setSelection(null)
        this.draw()
      }
      return
    }
    const right = box.x + box.w
    const bottom = box.y + box.h
    const hits: string[] = []
    for (const node of visibleNodes(tree)) {
      const b = this.boxes.get(node.id)
      if (!b) continue
      if (b.x < right && b.x + b.w > box.x && b.y < bottom && b.y + b.h > box.y) hits.push(node.id)
    }
    if (!additive) this.selection.clear()
    for (const id of hits) this.selection.add(id)
    this.focusId = hits.length > 0 ? hits[hits.length - 1]! : additive ? this.focusId : null
    this.draw()
  }

  /** 选中的节点 id，按文档序。批量删除要按文档序合并范围。 */
  private selectionIds(): string[] {
    const tree = this.tree
    if (!tree || this.selection.size === 0) return []
    const out: string[] = []
    const walk = (n: MindNode): void => {
      for (const c of n.children) {
        if (this.selection.has(c.id)) out.push(c.id)
        walk(c)
      }
    }
    walk(tree.root)
    return out
  }

  private async stepHistory(direction: HistoryDirection): Promise<void> {
    if (!this.canEdit()) return
    const file = this.file
    if (!file || this.session) return
    this.drag.cancel()
    this.historyBusy++
    try {
      const result = await this.bridge.historyStep(file, direction)
      if (result === 'conflict') new Notice(t('notice.historyConflict'))
      else if (result === 'empty') new Notice(t(direction === 'undo' ? 'notice.cannotUndo' : 'notice.cannotRedo'))
    } catch (err) {
      this.onWriteFailed(err, file)
    } finally {
      this.historyBusy--
    }
  }

  // ── 编辑会话 ────────────────────────────────────────────────

  /**
   * 移动端长按的起手。
   *
   * 只对触摸 / 手写笔生效：桌面端的左键按住不该弹菜单。
   * 期间允许 {@link LONG_PRESS_SLOP} 的抖动，超过就当成拖拽或平移并取消计时。
   */
  private readonly onLongPressDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return
    this.clearLongPress()
    if (!(e.target instanceof Element)) return
    // 折叠按钮 / 备注下拉 / 关联手柄有各自的点击语义
    if (e.target.closest('.om-toggle, .om-body-toggle, .om-rel-handle, .om-editor, .om-body-editor')) return
    const target = e.target
    const x = e.clientX
    const y = e.clientY
    this.longPressStart = { id: e.pointerId, x, y }
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null
      this.longPressStart = null
      if (!this.canEdit() || this.session) return
      this.longPressAt = Date.now()
      // 长按期间可能已经按住了节点，先收掉拖拽的候选态
      this.drag.cancel()
      this.openContextMenu(target, x, y)
    }, LONG_PRESS_MS)
  }

  private readonly onLongPressMove = (e: PointerEvent): void => {
    const start = this.longPressStart
    if (!start || start.id !== e.pointerId) return
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP) {
      this.clearLongPress()
    }
  }

  private readonly onLongPressEnd = (e: PointerEvent): void => {
    if (this.longPressStart?.id === e.pointerId) this.clearLongPress()
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
    this.longPressStart = null
  }

  private readonly onNodeMenu = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    // 长按刚刚弹过菜单：Android 还会补一个原生 contextmenu，别叠第二层
    if (Date.now() - this.longPressAt < LONG_PRESS_GUARD) {
      event.preventDefault()
      return
    }
    if (!this.canEdit() || this.session) return
    event.preventDefault()
    this.openContextMenu(event.target, event.clientX, event.clientY)
  }

  /**
   * 在某个位置弹出右键菜单（鼠标右键与移动端长按共用）。
   *
   * `target` 决定弹哪一种：标注 / 关联线有自己的菜单，节点走设置里编排好的按钮，
   * 空白处给「添加自由文本」。两种入口只差触发方式，菜单内容完全一致。
   */
  private openContextMenu(target: Element, x: number, y: number): void {
    // 外框 / 概要 / 关联线：直接给编辑 / 移除
    const anno = target.closest('[data-anno]')?.getAttribute('data-anno')
    if (anno) {
      const [kind, annoId, extra] = anno.split(':')
      if ((kind === 'box' || kind === 'summary') && annoId) {
        this.showAnnotationMenu(annoId, kind, x, y)
        return
      }
      if (kind === 'rel' && annoId !== undefined && extra !== undefined) {
        const index = Number.parseInt(extra, 10)
        if (Number.isInteger(index)) {
          this.showRelationMenu(annoId, index, x, y)
          return
        }
      }
    }
    const id = target.closest<HTMLElement>('.om-node')?.dataset.nodeId
    const node = id ? this.tree?.byId.get(id) : undefined
    if (!id || !node) {
      this.showEmptyMenu(x, y)
      return
    }
    this.showNodeMenu(id, node, x, y)
  }

  /** 按设置里的清单建节点菜单：先过滤掉当前不适用的按钮，再按用户排的顺序摆。 */
  private showNodeMenu(id: string, node: MindNode, x: number, y: number): void {
    const menu = new Menu()
    let added = 0
    let group = -1
    for (const action of this.host.settings.nodeMenu) {
      if (!this.canUseMenuAction(action, node)) continue
      const meta = NODE_MENU_META[action]
      if (added > 0 && meta.group !== group) menu.addSeparator()
      group = meta.group
      this.addMenuAction(menu, action, id, node)
      added++
    }
    // 一个按钮都不剩时不弹空菜单
    if (added === 0) return
    menu.showAtPosition({ x, y })
  }

  /** 这个按钮在当前节点上有没有意义（没有就不出现在菜单里）。 */
  private canUseMenuAction(action: NodeMenuAction, node: MindNode): boolean {
    const annotations = node.annotations
    switch (action) {
      case 'editBody':
        return node.depth > 0
      case 'addOrdered':
        return node.depth > 0 && this.host.settings.orderedListNodes
      case 'addUnordered':
        return node.depth > 0 && this.host.settings.listNodes
      case 'independent':
        return node.depth > 1
      case 'collapse':
        return node.children.length > 0
      case 'removeSummary':
        return !!annotations?.summary
      case 'removeBox':
        return !!annotations?.box
      case 'removeCallout':
        return !!annotations?.callout
      default:
        return true
    }
  }

  private addMenuAction(menu: Menu, action: NodeMenuAction, id: string, node: MindNode): void {
    const meta = NODE_MENU_META[action]
    const add = (title: string, icon: string, run: () => void): void => {
      menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(run))
    }
    switch (action) {
      case 'rename':
        add(t('menu.rename'), meta.icon, () => this.beginRename(id))
        break
      case 'editBody':
        add(t('menu.editBody'), meta.icon, () => this.beginBodyEdit(id))
        break
      case 'addChild':
        add(t('menu.addChild'), meta.icon, () => this.beginDraft({ type: 'child', parentId: id }))
        break
      case 'addSibling':
        add(t('menu.addSibling'), meta.icon, () => this.beginDraft({ type: 'sibling', refId: id }))
        break
      case 'addOrdered':
        add(t('menu.addOrdered'), meta.icon, () => this.beginDraft({ type: 'child', parentId: id, marker: '1.' }))
        break
      case 'addUnordered':
        add(t('menu.addUnordered'), meta.icon, () => this.beginDraft({ type: 'child', parentId: id, marker: '-' }))
        break
      case 'independent':
        add(t('menu.makeIndependent'), meta.icon, () => this.makeIndependent(id))
        break
      case 'collapse':
        add(
          t(node.collapsed ? 'menu.expand' : 'menu.collapse'),
          node.collapsed ? 'chevrons-up-down' : meta.icon,
          () => this.setCollapsed(node, !node.collapsed),
        )
        break
      case 'remove':
        add(t('menu.remove'), meta.icon, () => {
          this.setSelection(id)
          this.removeSelected()
        })
        break
      case 'summary':
        add(t(node.annotations?.summary ? 'menu.editSummary' : 'menu.addSummary'), meta.icon,
          () => this.openAnnotationForm(id, 'summary'))
        break
      case 'removeSummary':
        add(t('menu.removeSummary'), meta.icon, () => this.removeAnnotation(id, 'summary'))
        break
      case 'box':
        add(t(node.annotations?.box ? 'menu.editBox' : 'menu.addBox'), meta.icon,
          () => this.openAnnotationForm(id, 'box'))
        break
      case 'removeBox':
        add(t('menu.removeBox'), meta.icon, () => this.removeAnnotation(id, 'box'))
        break
      case 'callout':
        add(t(node.annotations?.callout ? 'menu.editCallout' : 'menu.addCallout'), meta.icon,
          () => this.openAnnotationForm(id, 'callout'))
        break
      case 'removeCallout':
        add(t('menu.removeCallout'), meta.icon, () => this.removeAnnotation(id, 'callout'))
        break
      default:
        break
    }
  }

  /** 右键外框 / 概要的菜单。 */
  private showAnnotationMenu(id: string, kind: 'box' | 'summary', x: number, y: number): void {
    const menu = new Menu()
    menu.addItem(item => item.setTitle(t(kind === 'summary' ? 'menu.editSummary' : 'menu.editBox'))
      .setIcon('pencil').onClick(() => this.openAnnotationForm(id, kind)))
    menu.addItem(item => item.setTitle(t(kind === 'summary' ? 'menu.removeSummary' : 'menu.removeBox'))
      .setIcon('trash-2').onClick(() => this.removeAnnotation(id, kind)))
    menu.showAtPosition({ x, y })
  }

  /** 右键空白：工具条 + 常用设置的按钮，按设置里的清单与顺序摆。 */
  private showEmptyMenu(x: number, y: number): void {
    const menu = new Menu()
    let added = 0
    let group = -1
    for (const action of this.host.settings.canvasMenu) {
      if (!this.canUseCanvasAction(action)) continue
      const meta = CANVAS_MENU_META[action]
      if (added > 0 && meta.group !== group) menu.addSeparator()
      group = meta.group
      this.addCanvasMenuAction(menu, action, x, y)
      added++
    }
    if (added === 0) return
    menu.showAtPosition({ x, y })
  }

  /** 空白处按钮的可用性：只有「添加自由文本」需要编辑权限，其余任何时候都能点。 */
  private canUseCanvasAction(action: CanvasMenuAction): boolean {
    return action !== 'freeTopic' || this.canEdit()
  }

  private addCanvasMenuAction(menu: Menu, action: CanvasMenuAction, x: number, y: number): void {
    const meta = CANVAS_MENU_META[action]
    const add = (title: string, icon: string, run: () => void, disabled = false): void => {
      menu.addItem(item => {
        item.setTitle(title).setIcon(icon)
        if (disabled) item.setDisabled(true)
        item.onClick(run)
      })
    }
    const historyIdle = this.canEdit() && !this.historyBusy && !this.session
    switch (action) {
      case 'freeTopic':
        add(t('menu.addFreeTopic'), meta.icon, () => this.addFreeTopic(x, y))
        break
      case 'fit':
        add(t('tool.fit'), meta.icon, () => this.fitToScreen())
        break
      case 'zoomIn':
        add(t('tool.zoomIn'), meta.icon, () => this.canvas.zoomBy(1.25))
        break
      case 'zoomOut':
        add(t('tool.zoomOut'), meta.icon, () => this.canvas.zoomBy(1 / 1.25))
        break
      case 'center':
        add(t('tool.center'), meta.icon, () => this.centerView())
        break
      case 'bodies':
        add(
          t(this.allBodiesOpen() || this.isReadMode() ? 'tool.bodiesClose' : 'tool.bodies'),
          meta.icon,
          () => this.toggleAllBodies(),
        )
        break
      case 'foldLevel':
        add(t('tool.foldLevel'), meta.icon, () => this.showFoldMenu({ x, y }))
        break
      case 'direction':
        add(t('tool.direction'), meta.icon, () => this.showDirectionMenu({ x, y }))
        break
      case 'theme':
        add(t('tool.theme'), meta.icon, () => this.showThemeMenu({ x, y }))
        break
      case 'style':
        add(t('tool.style'), meta.icon, () => this.openStyle())
        break
      case 'search':
        add(t('tool.search'), meta.icon, () => this.openFind())
        break
      case 'undo':
        add(t('menu.undo'), meta.icon, () => void this.stepHistory('undo'), !historyIdle)
        break
      case 'redo':
        add(t('menu.redo'), meta.icon, () => void this.stepHistory('redo'), !historyIdle)
        break
      case 'export':
        add(t('tool.export'), meta.icon, () => this.showExportMenu({ x, y }))
        break
      case 'lock':
        add(
          t(this.locked ? 'tool.unlock' : 'tool.lock'),
          this.locked ? 'lock' : meta.icon,
          () => this.toggleLock(),
          this.forcedLock || !this.file,
        )
        break
      case 'recite':
        add(t('tool.recite'), meta.icon, () => this.toggleRecite())
        break
      case 'mode':
        add(
          t(this.isReadMode() ? 'tool.editMode' : 'tool.readMode'),
          this.isReadMode() ? 'pencil' : meta.icon,
          () => this.toggleMode(),
        )
        break
      case 'settings':
        add(t('menu.openSettings'), meta.icon, () => this.openPluginSettings())
        break
      default:
        break
    }
  }

  /** 打开本插件的设置页；取不到设置面板时退回「设置」总入口。 */
  private openPluginSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { openTabById?: (id: string) => void; open?: () => void }
    }).setting
    if (setting?.openTabById) setting.openTabById('lenscript')
    else setting?.open?.()
  }

  /**
   * 在点击位置放一个自由主题：新建一个根节点，再用 `%%float%%` 把它摆到点击处。
   *
   * 两段写入（先建节点、再写注解）是为了拿到新节点的 id；
   * 偏移以「未浮动的根节点中心」为锚，因此不会因为刚加的这个节点而漂移。
   */
  private addFreeTopic(clientX: number, clientY: number): void {
    const tree = this.tree
    const file = this.file
    if (!tree || !file || !this.canEdit()) return
    const rect = this.canvas.viewportRect()
    const point = this.canvas.toContent(rect, clientX, clientY)
    const bounds = boundsOf(this.boxes)
    const centerX = bounds.w > 0 ? bounds.x + bounds.w / 2 : 0
    const centerY = bounds.h > 0 ? bounds.y + bounds.h / 2 : 0

    const label = t('freeTopic.default')
    const plan = createRoot(tree, label, this.parseOptions())
    const node = this.applyEdit(plan, (t2) => t2.root.children[t2.root.children.length - 1] ?? null, label)
    if (!node) return
    this.writeAnnotation(node.id, (annotations) => {
      annotations.float = { x: Math.round(point.x - centerX), y: Math.round(point.y - centerY) }
    })
    this.setSelection(node.id)
    this.draw()
    this.reveal(node.id)
  }

  // ── 标注（框 / 概要 / 标注气泡）──────────────────────────────

  /** 从本节点到最后一个兄弟，最多能覆盖几个。 */
  private maxSpan(node: MindNode): number {
    const parent = node.parent
    if (!parent) return 1
    const index = parent.children.indexOf(node)
    return Math.max(1, parent.children.length - index)
  }

  private openAnnotationForm(id: string, kind: 'summary' | 'box' | 'callout'): void {
    const node = this.tree?.byId.get(id)
    if (!node) return
    const existing = node.annotations
    if (kind === 'callout') {
      new AnnotationModal(this.app, {
        title: t('anno.calloutTitle'),
        text: existing?.callout?.text ?? '',
        span: 1,
        withSpan: false,
        onConfirm: ({ text }) => {
          const value = text.trim()
          this.writeAnnotation(id, (next) => {
            if (value === '') delete next.callout
            else next.callout = { text: value, ...(existing?.callout?.color ? { color: existing.callout.color } : {}) }
          })
        },
      }).open()
      return
    }
    // 多选时按「框选到的兄弟范围」生成：从第一个被选中的兄弟覆盖到最后一个
    let anchorId = id
    let anchor = node
    let suggested = 1
    if (this.selection.size > 1 && node.parent) {
      const siblings = node.parent.children
      const index = siblings.indexOf(node)
      let first = index
      let last = index
      siblings.forEach((child, i) => {
        if (!this.selection.has(child.id)) return
        first = Math.min(first, i)
        last = Math.max(last, i)
      })
      anchor = siblings[first] ?? node
      anchorId = anchor.id
      suggested = Math.max(1, last - first + 1)
    }
    const current = kind === 'summary' ? anchor.annotations?.summary : anchor.annotations?.box
    const maxSpan = this.maxSpan(anchor)
    new AnnotationModal(this.app, {
      title: t(kind === 'summary' ? 'anno.summaryTitle' : 'anno.boxTitle'),
      text: current?.text ?? '',
      span: current?.span ?? Math.min(maxSpan, suggested),
      withSpan: true,
      onConfirm: ({ text, span }) => {
        const value = { span: Math.max(1, Math.min(maxSpan, span)), text: text.trim() }
        this.writeAnnotation(anchorId, (next) => {
          if (kind === 'summary') next.summary = value
          else next.box = value
        })
      },
    }).open()
  }

  private removeAnnotation(id: string, kind: 'summary' | 'box' | 'callout'): void {
    this.writeAnnotation(id, (next) => {
      if (kind === 'summary') delete next.summary
      else if (kind === 'box') delete next.box
      else delete next.callout
    })
  }

  /** 把改动写回节点行尾注解：只重写 titleLine 一行。 */
  private writeAnnotation(id: string, mutate: (annotations: NodeAnnotations) => void): void {
    const tree = this.tree
    if (!tree || !this.canEdit()) return
    const node = tree.byId.get(id)
    if (!node) return
    const next: NodeAnnotations = {
      ...(node.annotations ?? { rels: [] }),
      rels: [...(node.annotations?.rels ?? [])],
    }
    mutate(next)
    let plan: EditPlan
    try {
      plan = setNodeAnnotations(tree, id, hasAnnotations(next) ? next : null)
    } catch (err) {
      this.report(err)
      return
    }
    this.applyEdit(plan)
  }

  /** 勾选 / 取消一个任务项：只改标题行的 `[ ]` / `[x]`。 */
  private toggleTask(id: string): void {
    const tree = this.tree
    if (!tree || !this.canEdit()) return
    const node = tree.byId.get(id)
    if (!node) return
    const next = toggleTaskText(node.text)
    if (next === node.text) return
    let plan: EditPlan
    try {
      plan = renameNode(tree, id, next)
    } catch (err) {
      this.report(err)
      return
    }
    this.applyEdit(plan, (t) => t.byId.get(id) ?? null, next)
    this.draw()
  }

  private startSibling(): void {
    const node = this.selectedNode()
    // 没有选中（空笔记、刚打开）时回车 = 新建一个自由根
    if (!node) this.beginDraft({ type: 'root' })
    else this.beginDraft({ type: 'sibling', refId: node.id })
  }

  private startChild(): void {
    const node = this.selectedNode()
    if (!node) return
    // 「忽略列表节点」开着时第 6 层下没法再挂子节点：列表语法会被解析回正文，
    // 写进去就是一棵看不见的子树。用用户的语言拦在编辑框打开之前。
    if (!this.host.settings.listNodes && !this.host.settings.orderedListNodes && node.depth >= 6) {
      new Notice(t('notice.listNodesRequired'))
      return
    }
    this.beginDraft({ type: 'child', parentId: node.id })
  }

  private selectedNode(): MindNode | null {
    if (!this.tree || !this.focusId) return null
    return this.tree.byId.get(this.focusId) ?? null
  }

  /**
   * 开一个草稿节点：先在内存树上挂出来，让它参与布局和渲染，编辑框盖在它上面。
   *
   * 【为什么不先往文件里写一个空节点再改名】——那样 Esc 会留下一行 `## `，
   * 而且一次新增会变成「插入 + 重命名」两次撤销。草稿只活在内存里，
   * 提交时才生成唯一的一次写入。
   */
  private beginDraft(intent: EditIntent): void {
    if (!this.canEdit() || this.historyBusy) return
    const tree = this.tree
    if (!tree || !this.file || this.session) return

    let parent: MindNode | null = null
    let index = 0
    if (intent.type === 'sibling') {
      const ref = tree.byId.get(intent.refId)
      if (!ref?.parent) return
      parent = ref.parent
      index = parent.children.indexOf(ref) + 1
    } else if (intent.type === 'child') {
      parent = intent.parentId === null ? tree.root : (tree.byId.get(intent.parentId) ?? null)
      if (!parent) return
      parent.collapsed = false // 往折叠着的节点里加子节点，得先让人看见
      index = intent.marker ? 0 : parent.children.length
    } else if (intent.type === 'root') {
      parent = tree.root
      index = parent.children.length
    } else {
      return
    }

    const draft = makeDraft(parent, index)
    tree.byId.set(DRAFT_ID, draft)
    this.session = {
      node: draft,
      intent,
      draft: true,
      originalText: '',
      returnTo: this.focusId,
    }
    this.openEditor(draft, '')
  }

  private beginRename(id: string): void {
    if (!this.canEdit() || this.historyBusy) return
    const tree = this.tree
    if (!tree || !this.file || this.session) return
    const node = tree.byId.get(id)
    if (!node) return
    this.session = {
      node,
      intent: { type: 'rename', id },
      draft: false,
      originalText: node.text,
      returnTo: id,
    }
    this.openEditor(node, node.text)
  }

  private openEditor(node: MindNode, text: string): void {
    // 进编辑态就只剩这一个选中：多选着开编辑框，用户分不清接下来的操作作用在谁身上
    this.setSelection(node.id)
    this.draw()
    const box = this.boxes.get(node.id)
    if (!box) {
      // 布局里没有它（理论上不会发生），别把用户卡在半个编辑态里
      this.cancelSession()
      return
    }
    this.canvas.ensureVisible(box)
    // 有正文时只盖住标题卡片那一条，正文继续露着；否则盖整个节点
    const metrics = this.metrics.get(node.id)
    const headH = metrics ? Math.min(box.h, metrics.titleH + PADDING_Y + 1) : box.h
    this.editor.start(metrics && metrics.bodyH > 0 ? { ...box, h: headH } : box, text)
  }

  // ── 正文编辑 ────────────────────────────────────────────────

  /** 从正文区打开多行编辑框。正文收起时先展开。 */
  private beginBodyEdit(id: string): void {
    if (!this.canEdit() || this.historyBusy) return
    const tree = this.tree
    const node = tree?.byId.get(id)
    if (!tree || !node || node.depth === 0) return
    if (this.session) return
    node.bodyOpen = true
    this.editingBodyId = id
    this.setSelection(id)
    this.draw()
    const box = this.boxes.get(id)
    if (box) this.canvas.ensureVisible(box)
    const rect = this.bodyRect(id)
    if (!rect) {
      this.editingBodyId = null
      this.draw()
      return
    }
    this.bodyEditor.start(rect, bodyTextOf(tree, node))
  }

  /**
   * 编辑框的位置：直接量备注卡片的真实矩形。
   *
   * 备注是一张独立的下拉卡片，高度由内容决定；用 DOM 的矩形换算成内容坐标，
   * 缩放 / 折叠 / 换字号之后都不会偏——不必再拿标题高度去推算。
   */
  private bodyRect(id: string): { x: number; y: number; w: number; h: number } | null {
    const el = this.nodeRenderer.noteElement(id)
    const box = this.boxes.get(id)
    if (!el) return box ? { x: box.x, y: box.y + box.h - 40, w: box.w, h: 40 } : null
    const viewport = this.canvas.viewportRect()
    const rect = el.getBoundingClientRect()
    const a = this.canvas.toContent(viewport, rect.left, rect.top)
    const b = this.canvas.toContent(viewport, rect.right, rect.bottom)
    return {
      x: a.x,
      y: a.y,
      w: Math.max(60, b.x - a.x),
      h: Math.max(24, b.y - a.y),
    }
  }

  /** 提交正文：只替换正文那几行，周围的空行与子节点一个字都不动。 */
  private commitBodyEdit(text: string): void {
    if (!this.canEdit()) {
      this.cancelBodyEdit()
      this.flushPending()
      return
    }
    const id = this.editingBodyId
    const tree = this.tree
    this.bodyEditor.stop()
    this.editingBodyId = null
    if (!id || !tree) {
      this.draw()
      return
    }
    if (!tree.byId.has(id)) {
      this.draw()
      return
    }
    let plan: EditPlan
    try {
      plan = setBody(tree, id, text)
    } catch (err) {
      this.report(err)
      this.draw()
      return
    }
    if (plan.length > 0) this.applyEdit(plan, (t) => t.byId.get(id) ?? null)
    else this.draw()
    this.canvas.focus()
    this.flushPending()
  }

  /** Esc / 关视图：正文一个字都不写回。 */
  private cancelBodyEdit(): void {
    if (!this.bodyEditor?.active && this.editingBodyId === null) return
    this.bodyEditor?.stop()
    this.editingBodyId = null
    this.draw()
  }

  /** 工具栏：展开 / 收起全部正文（阅读模式下由模式强制展开，这里只切编辑模式的状态）。 */
  private setAllBodies(open: boolean): void {
    const tree = this.tree
    if (!tree) return
    for (const node of tree.byId.values()) {
      if (node.depth > 0) node.bodyOpen = open
    }
    this.draw()
  }

  /** 一个按钮切换「打开 / 收起备注」：只要还有收起的就全开，否则全收。 */
  private toggleAllBodies(): void {
    this.setAllBodies(!this.allBodiesOpen())
  }

  /** 所有带备注的节点是否都已展开。没有备注的笔记返回 false（按钮本身会被隐藏）。 */
  private allBodiesOpen(): boolean {
    const tree = this.tree
    if (!tree) return false
    let found = false
    for (const node of tree.byId.values()) {
      if (node.depth === 0 || !hasBody(tree, node)) continue
      found = true
      if (node.bodyOpen !== true) return false
    }
    return found
  }

  /** 工具栏 / 命令：阅读 ⇄ 编辑。 */
  toggleMode(): void {
    const next = this.isReadMode() ? 'edit' : 'read'
    if (this.host.setMindmapViewMode) this.host.setMindmapViewMode(next)
    else (this.host as unknown as { mindmapViewMode?: string }).mindmapViewMode = next
    // host 的订阅会负责重绘；没有宿主回调时自己补一次
    if (!this.host.getMindmapViewMode) this.syncLock(true)
    this.draw()
    new Notice(t(next === 'read' ? 'notice.readModeOn' : 'notice.editModeOn'))
  }

  /** 背诵模式：只切 CSS 类，不碰数据、不重排。 */
  toggleRecite(): void {
    this.setRecite(!this.recite)
  }

  setRecite(on: boolean): void {
    if (this.recite === on) return
    this.recite = on
    this.canvas.content.toggleClass('is-recite', on)
    if (!on) {
      // 退出时把已揭开的标记收回去，下次进入仍是「全遮住」的状态
      for (const mark of this.canvas.content.querySelectorAll('mark.is-revealed')) {
        mark.classList.remove('is-revealed')
      }
    }
    this.toolbar.setRecite(on)
    new Notice(t(on ? 'notice.reciteOn' : 'notice.reciteOff'))
  }

  // ── 就地搜索 ────────────────────────────────────────────────

  private buildFindBar(host: HTMLElement): void {
    this.findBar = host.createDiv({ cls: 'om-find-bar is-hidden' })
    this.findInput = this.findBar.createEl('input', {
      cls: 'om-find-input',
      attr: { type: 'text', placeholder: t('search.placeholder'), spellcheck: 'false' },
    })
    this.findCount = this.findBar.createSpan({ cls: 'om-find-count' })
    const control = (text: string, label: string, run: () => void): HTMLButtonElement => {
      const btn = this.findBar.createEl('button', { cls: 'om-find-btn', text, attr: { 'aria-label': label } })
      btn.type = 'button'
      btn.addEventListener('pointerdown', (ev) => ev.preventDefault())
      btn.addEventListener('click', run)
      return btn
    }
    control('↑', t('tool.search'), () => this.stepFind(-1))
    control('↓', t('tool.search'), () => this.stepFind(1))
    control('✕', t('search.clear'), () => this.closeFind())

    this.findInput.addEventListener('input', () => this.runFind(true))
    this.findInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') {
        ev.preventDefault()
        this.stepFind(ev.shiftKey ? -1 : 1)
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        this.closeFind()
      }
    })
  }

  openFind(): void {
    if (!this.findBar) return
    this.findBar.removeClass('is-hidden')
    this.findInput.focus()
    this.findInput.select()
    if (this.findInput.value.trim()) this.runFind(true)
  }

  private closeFind(): void {
    if (!this.findBar) return
    this.findBar.addClass('is-hidden')
    this.findQuery = ''
    this.findHits = []
    this.findAt = 0
    this.findInput.value = ''
    this.findCount.setText('')
    if (this.search) this.applySearch()
    else {
      this.nodeRenderer.setSearch(new Map())
      this.draw()
    }
    this.canvas.focus()
  }

  /** 标题和正文都查；正文命中的节点自动展开。 */
  private runFind(jump: boolean): void {
    const tree = this.tree
    const query = this.findInput.value.trim()
    this.findQuery = query
    if (!tree || query === '') {
      this.findHits = []
      this.findAt = 0
      this.findCount.setText('')
      this.nodeRenderer.setSearch(new Map())
      this.draw()
      return
    }
    const needle = query.toLowerCase()
    const nodes = [...tree.byId.values()]
      .filter((node) => node.depth > 0)
      .sort((a, b) => a.titleLine - b.titleLine)
    const hits: string[] = []
    const terms = new Map<string, string[]>()
    for (const node of nodes) {
      const inTitle = node.text.toLowerCase().includes(needle)
      const inBody = bodyTextOf(tree, node).toLowerCase().includes(needle)
      if (!inTitle && !inBody) continue
      hits.push(node.id)
      terms.set(node.id, [query])
      if (inBody) node.bodyOpen = true
      for (let parent = node.parent; parent; parent = parent.parent) parent.collapsed = false
    }
    this.findHits = hits
    if (this.findAt >= hits.length) this.findAt = 0
    this.nodeRenderer.setSearch(terms)
    this.findCount.setText(hits.length ? t('search.hit', this.findAt + 1, hits.length) : t('search.none'))
    if (jump && hits.length) {
      const id = hits[this.findAt]
      if (id) this.setSelection(id)
    }
    this.draw()
    if (jump && hits.length) this.focusFindHit()
  }

  private stepFind(delta: number): void {
    if (this.findHits.length === 0) {
      this.runFind(false)
      if (this.findHits.length === 0) return
    }
    this.findAt = (this.findAt + delta + this.findHits.length) % this.findHits.length
    this.findCount.setText(t('search.hit', this.findAt + 1, this.findHits.length))
    const id = this.findHits[this.findAt]
    if (!id) return
    this.setSelection(id)
    this.draw()
    this.focusFindHit()
  }

  private focusFindHit(): void {
    const id = this.findHits[this.findAt]
    if (!id) return
    const box = this.boxes.get(id)
    if (box) this.canvas.centerOn(box, true, 0.9)
  }

  // ── 折叠层级 / 方向 / 居中 / 导出 ───────────────────────────

  /** @param level 最大可见层数；null = 全部展开。 */
  setFoldLevel(level: number | null): void {
    const tree = this.tree
    if (!tree) return
    const walk = (node: MindNode): void => {
      node.collapsed = level !== null && node.children.length > 0 && node.depth >= level
      for (const child of node.children) walk(child)
    }
    walk(tree.root)
    this.draw()
  }

  /** 子菜单的展开位置：工具条按钮传元素，右键菜单传指针坐标。 */
  private submenuPoint(anchor: HTMLElement | { x: number; y: number }): { x: number; y: number } {
    if (!(anchor instanceof HTMLElement)) return anchor
    const rect = anchor.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom + 4 }
  }

  private showFoldMenu(anchor: HTMLElement | { x: number; y: number }): void {
    const menu = new Menu()
    menu.addItem((item) => item.setTitle(t('tool.foldTopic')).onClick(() => this.setFoldLevel(1)))
    for (let level = 2; level <= 6; level++) {
      menu.addItem((item) => item.setTitle(t('tool.foldTo', level)).onClick(() => this.setFoldLevel(level)))
    }
    menu.showAtPosition(this.submenuPoint(anchor))
  }

  private showDirectionMenu(anchor: HTMLElement | { x: number; y: number }): void {
    const menu = new Menu()
    const options: Array<{ value: LayoutDirection; label: string; icon: string }> = [
      { value: 'right', label: t('direction.right'), icon: 'arrow-right' },
      { value: 'left', label: t('direction.left'), icon: 'arrow-left' },
      { value: 'both', label: t('direction.both'), icon: 'move-horizontal' },
    ]
    for (const option of options) {
      menu.addItem((item) => item
        .setTitle(option.label)
        .setIcon(option.icon)
        .setChecked(this.style.structure !== 'org-down' && this.direction === option.value)
        .onClick(() => this.applyDirection(option.value)))
    }
    menu.addSeparator()
    menu.addItem((item) => item
      .setTitle(t('direction.down'))
      .setIcon('git-branch-down')
      .setChecked(this.style.structure === 'org-down')
      .onClick(() => this.applyStructure('org-down')))
    menu.showAtPosition(this.submenuPoint(anchor))
  }

  /** 方向跟样式一起写进插件设置（每篇笔记一份），和样式窗口里改是同一条路。 */
  private applyDirection(direction: LayoutDirection): void {
    const file = this.file
    if (!file) return
    this.host.styles.applyFile(file.path, { ...this.style, structure: 'mindmap', direction })
  }

  /** 切换结构：横向导图 ⇄ 向下组织图。 */
  private applyStructure(structure: 'mindmap' | 'org-down'): void {
    const file = this.file
    if (!file) return
    this.host.styles.applyFile(file.path, { ...this.style, structure })
  }

  private centerView(): void {
    const box = this.focusId ? this.boxes.get(this.focusId) : undefined
    this.canvas.centerOn(box ?? this.bounds, true)
  }

  private showExportMenu(anchor: HTMLElement | { x: number; y: number }): void {
    const menu = new Menu()
    const formats: Array<{ format: 'svg' | 'png' | 'pdf'; label: string; icon: string }> = [
      { format: 'svg', label: t('export.svg'), icon: 'image' },
      { format: 'png', label: t('export.png'), icon: 'image-plus' },
      { format: 'pdf', label: t('export.pdf'), icon: 'file-text' },
    ]
    for (const entry of formats) {
      menu.addItem((item) => item
        .setTitle(entry.label)
        .setIcon(entry.icon)
        .onClick(() => void this.exportAs(entry.format)))
    }
    menu.showAtPosition(this.submenuPoint(anchor))
  }

  async exportAs(format: 'svg' | 'png' | 'pdf'): Promise<void> {
    const file = this.file
    if (!file) {
      new Notice(t('notice.openMindmapFirst'))
      return
    }
    try {
      this.motion.finish()
      const background = getComputedStyle(this.contentEl).getPropertyValue('--background-primary').trim()
      await exportMap(this.canvas.content, file.basename, format, background, 2, 'fit', 24)
    } catch (err) {
      console.error(err)
      new Notice(t(err instanceof ExportSizeError ? 'style.exportTooLarge' : 'style.exportFailed'))
    }
  }

  /** 一键主题：只换配色 / 连线 / 字形 / 分级着色，间距与字号保持用户当前值。 */
  private showThemeMenu(anchor: HTMLElement | { x: number; y: number }): void {
    const menu = new Menu()
    for (const preset of THEME_PRESETS) {
      menu.addItem((item) => item
        .setTitle(t(preset.labelKey))
        .setChecked(matchesPreset(this.style, preset))
        .onClick(() => this.applyThemePreset(preset)))
    }
    menu.showAtPosition(this.submenuPoint(anchor))
  }

  private applyThemePreset(preset: ThemePreset): void {
    const file = this.file
    if (!file) return
    this.host.styles.applyFile(file.path, { ...this.style, ...preset.style })
    new Notice(t('notice.themeApplied', t(preset.labelKey)))
  }

  /** 输入时的乐观更新：直接改内存里的 text → 重排 → 编辑框跟着新盒子走。 */
  private readonly onEditorInput = (text: string): void => {
    if (!this.canEdit()) return
    const s = this.session
    if (!s) return
    s.node.text = text
    this.draw()
    const box = this.boxes.get(s.node.id)
    if (box) {
      this.editor.place(box)
      this.canvas.ensureVisible(box)
    }
  }

  private readonly onEditorCommit = (text: string, next: CommitNext): void => {
    if (!this.canEdit()) { this.cancelSession(); this.flushPending(); return }
    const s = this.session
    if (!s) return
    const value = text.trim()

    // 一个字都没打的草稿，被「点到别处」结束掉时不该往笔记里塞一行空标题——
    // 用户根本没输入任何东西。按 Enter / Tab 明确要求继续时才照常创建。
    if (s.draft && value === '' && next === 'none') {
      this.onEditorCancel()
      return
    }

    this.editor.stop()
    this.session = null

    const committed = this.commit(s, value)
    this.canvas.focus()

    if (committed && next !== 'none') {
      this.beginDraft(
        next === 'sibling'
          ? { type: 'sibling', refId: committed }
          : { type: 'child', parentId: committed },
      )
      return
    }
    if (committed) this.select(committed)
    this.flushPending()
  }

  private readonly onEditorCancel = (): void => {
    this.cancelSession()
    this.canvas.focus()
    this.flushPending()
  }

  /** Esc / 关视图：把内存里的乐观改动原样退回去，文件一个字都不写。 */
  private cancelSession(): void {
    const s = this.session
    this.session = null
    this.editor.stop()
    if (!s) return
    if (s.draft) this.detachDraft(s.node)
    else s.node.text = s.originalText
    // 回到按下 Enter / F2 之前选中的那个节点；它可能已经被外部改动删掉了，所以要核一遍
    this.setSelection(s.returnTo !== null && this.tree?.byId.has(s.returnTo) ? s.returnTo : null)
    this.draw()
  }

  /**
   * 落盘一次编辑，返回提交后目标节点的 id。
   *
   * 顺序很重要：先把草稿从树上摘掉再 planEdit——`insertChild` 要数父节点现有的子节点，
   * 草稿混在里面会把插入点算到它自己后面。
   */
  private commit(s: Session, text: string): string | null {
    const tree = this.tree
    if (!tree || !this.file) return null
    if (s.draft) this.detachDraft(s.node)
    else s.node.text = s.originalText // plan 只按行号取原文，内存里的乐观值先退回去

    let outcome: EditOutcome
    try {
      outcome = planEdit(tree, s.intent, text, this.parseOptions())
    } catch (err) {
      this.report(err)
      this.draw() // 乐观改动已经退回去了，把画面同步回真实状态
      return null
    }
    // applyEdit 里的 refresh 换了一棵新树，节点得按结构位置重新找
    const node = this.applyEdit(outcome.plan, (t) => resolveAt(t, outcome.parentId, outcome.index), text.trim())
    if (node) {
      this.setSelection(node.id)
      this.draw()
      this.reveal(node.id)
    }
    return node?.id ?? null
  }

  private detachDraft(draft: MindNode): void {
    const parent = draft.parent
    if (parent) {
      const i = parent.children.indexOf(draft)
      if (i >= 0) parent.children.splice(i, 1)
    }
    draft.parent = null
    this.tree?.byId.delete(DRAFT_ID)
    this.selection.delete(DRAFT_ID)
    if (this.focusId === DRAFT_ID) this.focusId = null
  }

  /**
   * Delete / Backspace：删掉选中的节点【及其整棵子树】。
   *
   * Ctrl+左键多选时一次删掉一批（M6）：`removeSubtree` 自己会过滤掉
   * 「祖先已在删除列表里」的 id 并合并相邻范围，所以这里一次性全交给它，
   * 得到的仍是【一次】可撤销的变更。
   */
  private removeSelected(): void {
    if (!this.canEdit()) return
    const tree = this.tree
    const ids = this.selectionIds()
    if (!tree || ids.length === 0) return

    let plan: EditPlan
    try {
      plan = removeSubtree(tree, ids)
    } catch (err) {
      this.report(err)
      return
    }
    const nextId = selectionAfterBatch(tree, ids)
    // 删除之后笔记跟到「删完剩下的那个选中节点」；一个都不剩就别滚了（M11）
    this.applyEdit(plan, (t) => (nextId === null ? null : (t.byId.get(nextId) ?? null)))
    this.setSelection(nextId)
    this.draw()
    this.reveal(nextId)
  }

  /**
   * 拖到视口边缘时缓缓平移画布。
   *
   * 不这么做的话，想拖到屏幕外的节点只能先松手、缩小画布、再拖一次——
   * 长距离搬运全靠运气，这也是「拖拽不稳」的一部分。
   */
  private autoPan(x: number, y: number): boolean {
    const rect = this.canvas.viewportRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false
    const edge = 44
    const max = 14
    let dx = 0
    let dy = 0
    if (x < rect.left + edge) dx = ((rect.left + edge - x) / edge) * max
    else if (x > rect.right - edge) dx = -((x - (rect.right - edge)) / edge) * max
    if (y < rect.top + edge) dy = ((rect.top + edge - y) / edge) * max
    else if (y > rect.bottom - edge) dy = -((y - (rect.bottom - edge)) / edge) * max
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return false
    // user=false：自动平移不进「用户视野」记忆，免得拖一次就把布局位置写进设置
    this.canvas.panBy(dx, dy, false)
    return true
  }

  /** 拖拽落点（M6）。结构变更本身全在 core/tree.ts 的 `moveSubtree` / `mergeIntoNode` 里。 */
  private readonly onDrop = (
    dragId: string,
    result: DropResult,
    target: DropTarget,
    x: number,
    y: number,
  ): void => {
    if (!this.canEdit()) return
    const tree = this.tree
    if (!tree || !this.file) return
    const node = tree.byId.get(dragId)
    if (!node) return

    // 落到「独立」投放区：从父节点上摘下来，原地变成独立节点
    if (target.zone === 'independent') {
      this.makeIndependent(dragId)
      return
    }

    // 落到画布空白处：不再被布局排到某一个固定位置，直接按落点成为自由节点
    if (target.id === null) {
      this.makeIndependent(dragId, this.contentPointAt(x, y))
      return
    }

    // 只有「落到节点身上」才需要选择动作；上 / 下边缘仍然是普通重排
    if (target.zone === 'into' && target.id !== null && target.id !== dragId) {
      const parent = node.parent
      const intoParent = !!parent && parent.depth > 0 && parent.id === target.id
      const targetNode = tree.byId.get(target.id)
      // 拖回自己的上级（父 / 祖父……）：往自己所在的分支里再搬一次没有新意，合并才是有意义的动作
      const intoAncestor = !!targetNode && targetNode.depth > 0 && targetIsAncestor(node, targetNode.id)
      const childless = node.children.length === 0
      // 独立块还没有确定的结构位置，落到节点上时「成为子节点」和「合并」都说得通
      const independent = !!node.annotations?.float
      const action = this.host.settings.dropAction

      if (childless && (intoAncestor || independent)) {
        // 用户明确设了「合并」，就别多问
        if (action === 'mergeNote') {
          this.mergeInto(dragId, target.id, 'note')
          return
        }
        if (action === 'mergeText') {
          this.mergeInto(dragId, target.id, 'text')
          return
        }
        // 拖回上级时「成为子节点」只是换层 / 原地重排，默认设置直接搬走会让人摸不着合并入口；
        // 父节点再「成为子节点」等于排到末尾，没有意义，菜单里就只留合并
        this.showDropMenu(dragId, target.id, x, y, !intoParent, true)
        return
      }

      if (intoAncestor) {
        // 带子节点：合并确实做不了（得先给后代找去处），但菜单照弹、把原因写在按钮上，
        // 别让人以为「有时候有这个功能、有时候没有」
        this.showDropMenu(dragId, target.id, x, y, true, false)
        return
      }
      if (childless) {
        // 有子节点的节点不能合并（要先给后代找去处），直接成为子节点
        if (action === 'ask') {
          this.showDropMenu(dragId, target.id, x, y, true)
          return
        }
        if (action === 'mergeNote') {
          this.mergeInto(dragId, target.id, 'note')
          return
        }
        if (action === 'mergeText') {
          this.mergeInto(dragId, target.id, 'text')
          return
        }
      }
    }
    this.moveTo(dragId, result)
  }

  /** 拖到节点身上时弹出的动作菜单。`canMerge=false` 时合并按钮禁用并说明原因。 */
  private showDropMenu(
    dragId: string,
    targetId: string,
    x: number,
    y: number,
    canChild: boolean,
    canMerge = true,
  ): void {
    const tree = this.tree
    if (!tree) return
    const source = tree.byId.get(dragId)
    const target = tree.byId.get(targetId)
    if (!source || !target) return
    const menu = new Menu()
    if (canChild) {
      menu.addItem(item => item.setTitle(t('menu.dropChild')).setIcon('git-branch')
        .onClick(() => {
          const result = resolveDrop(tree, dragId, { id: targetId, zone: 'into' })
          if (result) this.moveTo(dragId, result)
        }))
    }
    if (!canMerge) {
      menu.addItem(item => item.setTitle(t('menu.mergeNeedsChildless')).setIcon('merge').setDisabled(true))
    } else {
      menu.addItem(item => item.setTitle(t('menu.mergeNote', target.text || source.text)).setIcon('sticky-note')
        .onClick(() => this.mergeInto(dragId, targetId, 'note')))
      menu.addItem(item => item.setTitle(t('menu.mergeText')).setIcon('merge')
        .onClick(() => this.mergeInto(dragId, targetId, 'text')))
    }
    // 松手时若只是弹菜单，先把自由拖动的预览位置还原，别让节点悬在半空
    this.draw()
    menu.showAtPosition({ x, y })
  }

  /** 普通移动（成为子节点 / 重排）。 */
  private moveTo(dragId: string, result: DropResult): MindNode | null {
    const tree = this.tree
    if (!tree) return null
    // 同 startChild 的拦截，但要看整棵子树：标题层级跳跃被保留（A.3），
    // 父挪深一层可能把某个后代推过第 6 层。core 里的同名断言只是兜底。
    if (!this.host.settings.listNodes && !this.host.settings.orderedListNodes) {
      const node = tree.byId.get(dragId)
      const parentDepth = result.parentId === null ? 0 : (tree.byId.get(result.parentId)?.depth ?? 0)
      if (node && parentDepth + 1 + maxDepthDrop(node) >= 7) {
        new Notice(t('notice.listNodesRequired'))
        return null
      }
    }
    // 菜单里点了「成为子节点」，但它本来就在那个位置：别为一次原地不动写文件、塞一条撤销记录
    if (isSamePosition(tree, dragId, result)) {
      this.draw()
      return tree.byId.get(dragId) ?? null
    }
    let plan: EditPlan
    try {
      plan = moveSubtree(tree, dragId, result.parentId, result.index, this.parseOptions())
    } catch (err) {
      this.report(err)
      return null
    }
    // 换了一棵新树，被移动的节点要按结构位置重新找（它的 id 由 reconcile 保住，但对象是新的）
    const node = this.applyEdit(plan, (t) => resolveAt(t, result.parentId, result.index), tree.byId.get(dragId)?.text)
    if (!node) return null
    // 独立节点一旦有了明确的结构落点，就不该再带着 %%float%% 漂在父节点旁边
    if (node.annotations?.float) {
      this.writeAnnotation(node.id, (annotations) => { delete annotations.float })
    }
    // 放进一个折叠着的节点里，得让人看见结果；上面二次写回后要拿新树再展开
    const fresh = this.tree?.byId.get(node.id) ?? node
    for (let p = fresh.parent; p; p = p.parent) p.collapsed = false
    this.setSelection(fresh.id)
    this.draw()
    this.reveal(fresh.id)
    return fresh
  }

  /** 合并到任意目标节点：写回后把选中落在目标上。 */
  private mergeInto(sourceId: string, targetId: string, mode: MergeMode): void {
    const tree = this.tree
    if (!tree || !this.canEdit()) return
    let plan: EditPlan
    try {
      plan = mergeIntoNode(tree, sourceId, targetId, mode)
    } catch (err) {
      this.report(err)
      return
    }
    // 合并会改目标文字（'text'）或只动正文（'note'），不套用「文字必须原样」的校验
    const node = this.applyEdit(plan, (t) => t.byId.get(targetId) ?? null)
    if (!node) return
    for (let p = node.parent; p; p = p.parent) p.collapsed = false
    this.setSelection(targetId)
    this.draw()
    this.reveal(targetId)
  }

  /**
   * 把节点变成「独立节点」：从父节点上摘下来成为自由根，并用 `%%float%%` 记住它当前的屏幕位置。
   *
   * 两步写入（先移动、再写注解）是为了拿到移动后的树：自由根的中心锚点要按
   * 「其余非浮动根节点」重新算一遍，才不会被它自己推偏。
   */
  private makeIndependent(id: string, targetCenter?: { x: number; y: number }): void {
    const tree = this.tree
    if (!tree || !this.canEdit() || this.historyBusy) return
    const node = tree.byId.get(id)
    const box = this.boxes.get(id)
    if (!node || node.depth < 1) return
    if (!box && !targetCenter) return
    const center = targetCenter ?? {
      x: (box?.x ?? 0) + (box?.w ?? 0) / 2,
      y: (box?.y ?? 0) + (box?.h ?? 0) / 2,
    }

    // 本来就是根节点（比如把普通绪论节点拖到空白处）时，文档序没得重排，
    // 只需要补一个 %%float%%，否则 applyEdit 的「空计划」会让它原地弹回去。
    if (node.depth > 1) {
      const index = tree.root.children.filter((c) => c !== node).length
      let plan: EditPlan
      try {
        plan = moveSubtree(tree, id, null, index, this.parseOptions())
      } catch (err) {
        this.report(err)
        return
      }
      if (!this.applyEdit(plan, (t) => t.byId.get(id) ?? null)) return
    }
    const moved = this.tree
    if (!moved) return

    // 锚点 = 其余非浮动根节点的包围盒中心（与 layout/applyFloats 的算法一致）
    const next = layout(moved, this.layoutOptions())
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const child of moved.root.children) {
      if (child.id === id || child.annotations?.float) continue
      const b = next.get(child.id)
      if (!b) continue
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w)
      maxY = Math.max(maxY, b.y + b.h)
    }
    const anchor = minX === Infinity
      ? { x: 0, y: 0 }
      : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    this.writeAnnotation(id, (annotations) => {
      annotations.float = { x: Math.round(center.x - anchor.x), y: Math.round(center.y - anchor.y) }
    })
    this.setSelection(id)
    this.draw()
    this.reveal(id)
  }

  // ── 自由拖动（独立节点）────────────────────────────────────

  /** 客户端坐标 → 布局坐标。 */
  private contentPointAt(clientX: number, clientY: number): { x: number; y: number } {
    return this.canvas.toContent(this.canvas.viewportRect(), clientX, clientY)
  }

  /**
   * 自由拖动的「锚点」：`%%float%%` 的偏移永远相对它计算。
   *
   * - 挂在普通节点下的浮动节点：锚点是父节点中心；
   * - 浮动根：锚点是【其余非浮动根节点】包围盒的中心（与 layout/applyFloats 一致）。
   */
  private floatAnchorIn(node: MindNode, boxes: LayoutResult): { x: number; y: number } {
    const parent = node.parent
    if (parent && parent.depth > 0) {
      const box = boxes.get(parent.id)
      if (box) return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const child of parent?.children ?? []) {
      if (child.id === node.id || child.annotations?.float) continue
      const box = boxes.get(child.id)
      if (!box) continue
      minX = Math.min(minX, box.x)
      minY = Math.min(minY, box.y)
      maxX = Math.max(maxX, box.x + box.w)
      maxY = Math.max(maxY, box.y + box.h)
    }
    if (minX === Infinity) return { x: 0, y: 0 }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  }

  /** 记下拖动前的几何；之后每一帧都在这个快照上平移，误差不会累积。 */
  private beginFreeDrag(id: string): void {
    const tree = this.tree
    const node = tree?.byId.get(id)
    if (!tree || !node) return
    this.motion.finish()
    this.freeDragIds = subtreeIds(node)
    this.freeDragBase = new Map()
    for (const [key, box] of this.boxes) this.freeDragBase.set(key, { ...box })
  }

  /** 拖动中：只挪坐标与重画，不写文件。 */
  private previewFreeDrag(id: string, dx: number, dy: number): void {
    const tree = this.tree
    const ids = this.freeDragIds
    const base = this.freeDragBase
    if (!tree || !ids || !base) return
    let moved = false
    for (const key of ids) {
      const source = base.get(key)
      const box = this.boxes.get(key)
      if (!source || !box) continue
      box.x = source.x + dx
      box.y = source.y + dy
      moved = true
    }
    if (!moved) return
    const nodes = visibleNodes(tree)
    this.bounds = boundsOf(this.boxes)
    this.nodeRenderer.render(nodes, this.boxes, this.selection, rootSide(this.direction), this.bodySource)
    this.connectors.render(
      nodes,
      this.boxes,
      this.style.branch,
      this.bounds.x + this.bounds.w,
      this.bounds.y + this.bounds.h,
      this.orientation(),
    )
    this.annotations.render(nodes, this.boxes, this.orientation(), this.currentFont().size)
  }

  /** 松手：把落点换算成相对锚点的偏移，写回 `%%float%%`。 */
  private commitFreeDrag(id: string, dx: number, dy: number): void {
    const tree = this.tree
    const node = tree?.byId.get(id)
    const base = this.freeDragBase
    const own = base?.get(id)
    this.freeDragIds = null
    this.freeDragBase = null
    if (!tree || !node || !base || !own) return
    const center = { x: own.x + own.w / 2 + dx, y: own.y + own.h / 2 + dy }
    const anchor = this.floatAnchorIn(node, base)
    this.writeAnnotation(id, (annotations) => {
      annotations.float = {
        x: Math.round(center.x - anchor.x),
        y: Math.round(center.y - anchor.y),
      }
    })
    this.setSelection(id)
    this.draw()
    this.canvas.focus()
  }

  /** 自由拖动转成了结构落点：清掉快照即可，不重画（结构变更自己会重画）。 */
  private releaseFreeDrag(): void {
    this.freeDragIds = null
    this.freeDragBase = null
  }

  /** Esc / 手势中断：丢掉预览位移，回到文件里的位置。 */
  private cancelFreeDrag(): void {
    this.freeDragIds = null
    this.freeDragBase = null
    this.draw()
  }

  // ── 关联线 ──────────────────────────────────────────────────

  /** 某个节点现有的锚点 id（`%%id=…%%`），没有就现场生成一个不重名的。 */
  private anchorFor(node: MindNode): string {
    const tree = this.tree
    if (node.annotations?.anchor) return node.annotations.anchor
    const used = new Set<string>()
    for (const n of tree?.byId.values() ?? []) {
      if (n.annotations?.anchor) used.add(n.annotations.anchor)
    }
    let i = 1
    while (used.has(`r${i}`)) i++
    const id = `r${i}`
    this.writeAnnotation(node.id, (annotations) => {
      annotations.anchor = id
    })
    return id
  }

  /**
   * 从 fromId 拖到 toId：建立一条关联线。
   *
   * 写法沿用 `%%rel%%` 的数据模型：目标节点挂 `%%id=…%%` 当锚点，源节点写
   * `%%rel=锚点%%`。新画的一律是单向（箭头指向目标），右键那条线可以改成双向。
   */
  private createRelation(fromId: string, toId: string): void {
    const tree = this.tree
    if (!tree || !this.canEdit()) return
    const from = tree.byId.get(fromId)
    const to = tree.byId.get(toId)
    if (!from || !to || from === to) return
    // 已经指过去了就不重复画
    const anchor = this.anchorFor(to)
    const latest = this.tree?.byId.get(fromId)
    if (latest?.annotations?.rels?.some((rel) => rel.target === anchor)) return
    this.writeAnnotation(fromId, (annotations) => {
      annotations.rels = [...(annotations.rels ?? []), { target: anchor, text: '' }]
    })
    this.canvas.focus()
  }

  /** 右键关联线：编辑文字 / 切换单向双向 / 删除。 */
  private showRelationMenu(sourceId: string, index: number, x: number, y: number): void {
    const node = this.tree?.byId.get(sourceId)
    const rel = node?.annotations?.rels?.[index]
    if (!node || !rel) return
    const menu = new Menu()
    menu.addItem(item => item.setTitle(t('menu.editRelation')).setIcon('pencil')
      .onClick(() => this.editRelationText(sourceId, index)))
    menu.addItem(item => item.setTitle(t(rel.both ? 'menu.relSingle' : 'menu.relBoth')).setIcon('repeat')
      .onClick(() => this.writeAnnotation(sourceId, (annotations) => {
        const list = annotations.rels ?? []
        const current = list[index]
        if (!current) return
        list[index] = { ...current, both: !current.both }
      })))
    menu.addSeparator()
    menu.addItem(item => item.setTitle(t('menu.removeRelation')).setIcon('trash-2')
      .onClick(() => this.writeAnnotation(sourceId, (annotations) => {
        annotations.rels = (annotations.rels ?? []).filter((_, i) => i !== index)
      })))
    menu.showAtPosition({ x, y })
  }

  private editRelationText(sourceId: string, index: number): void {
    const rel = this.tree?.byId.get(sourceId)?.annotations?.rels?.[index]
    if (!rel) return
    new AnnotationModal(this.app, {
      title: t('anno.relationTitle'),
      text: rel.text,
      span: 1,
      withSpan: false,
      onConfirm: ({ text }) => {
        this.writeAnnotation(sourceId, (annotations) => {
          const list = annotations.rels ?? []
          const current = list[index]
          if (current) list[index] = { ...current, text }
        })
      },
    }).open()
  }


  /**
   * 应用一个 EditPlan：本地同步算出新文本并立刻重绘，落盘异步排队。
   *
   * 这样连按 10 次回车时，第 2 次的行号基准是第 1 次之后的文本，不必等 I/O 回来；
   * 写入在 DocumentBridge 里排队，顺序与这里生成的顺序一致。
   *
   * @param locate 在写入后的新树上找出这次编辑的目标节点。它决定笔记要跟到哪一行（M11），
   *   同时作为返回值交还给调用方——那棵树只在这里现成，调用方不必自己再找一遍。
   */
  private applyEdit(plan: EditPlan, locate?: (tree: MindTree) => MindNode | null, expectedText?: string): MindNode | null {
    if (!this.canEdit()) return null
    const tree = this.tree
    const file = this.file
    if (!tree || !file || plan.length === 0 || this.historyBusy) return null
    const base = tree.lines
    const eol = tree.eol

    let text: string
    try {
      text = joinLines(applyPlan(base, plan), eol)
    } catch (err) {
      this.report(err)
      return null
    }
    if (locate && expectedText !== undefined) {
      const parsed = reconcile(tree, parse(text, this.parseOptions()))
      if (locate(parsed)?.text !== expectedText) {
        new Notice(t('notice.invalidStructure'))
        this.draw()
        return null
      }
    }
    this.refresh(text)

    // refresh 之后 this.tree 已经是写入后的那棵树，目标节点的行号才是笔记该停的位置。
    // 跟随受「单击即跳转」管：关掉那个开关的人本来就不想让编辑器跟着导图动。
    const target = this.tree && locate ? locate(this.tree) : null
    const reveal = target && this.host.settings.clickToJump ? target.titleLine : undefined
    this.bridge
      .applyPlan(file, base, plan, eol, reveal)
      .catch((err: unknown) => this.onWriteFailed(err, file))
    return target
  }

  /**
   * 写盘失败（多半是文件在别处被改过、行号已失效）。
   *
   * 此时内存里的树是「我们以为的样子」，和磁盘不一致，必须以文件为准重新来过。
   */
  private onWriteFailed(err: unknown, file: TFile): void {
    if (this.file !== file || !this.ready) { this.report(err); return }
    if (this.resyncing) return
    this.resyncing = true
    this.report(err)
    void this.resync()
  }

  private async resync(): Promise<void> {
    try {
      this.cancelSession()
      const file = this.file
      if (!file) return
      this.tree = null
      this.setSelection(null)
      const text = await this.bridge.settledText(file)
      if (this.file === file && this.ready) this.refresh(text)
    } finally {
      this.resyncing = false
    }
  }

  private report(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    new Notice(t('notice.operationAborted', msg))
    console.error('[outline-mindmap]', err)
  }
}

/** 只认 Markdown 笔记；PDF、图片、Canvas 之类的文件视图一律当没有。 */
function markdownOnly(file: TFile | null): TFile | null {
  return file && file.extension === 'md' ? file : null
}

/**
 * 批量删除后，选中该落到哪儿。
 *
 * 从第一个（文档序）被删节点出发问 `selectionAfterRemoval`，若答案本身也在这批要删的
 * 范围里就继续往下问。走过的记下来——两个互为候选的根节点会把它绕成死循环。
 */
function selectionAfterBatch(tree: MindTree, ids: string[]): string | null {
  const first = ids[0]
  if (first === undefined) return null
  const doomed = new Set<string>()
  for (const id of ids) {
    const node = tree.byId.get(id)
    if (node) for (const sub of subtreeIds(node)) doomed.add(sub)
  }

  const seen = new Set<string>()
  let candidate = selectionAfterRemoval(tree, first)
  while (candidate !== null && doomed.has(candidate)) {
    if (seen.has(candidate)) return null
    seen.add(candidate)
    candidate = selectionAfterRemoval(tree, candidate)
  }
  return candidate
}

function arrowToDirection(key: string): NavDirection {
  switch (key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return 'left'
    default:
      return 'right'
  }
}

/**
 * 造一个草稿节点并挂到父节点下。
 *
 * 行号一律给 -1：它在文件里没有对应的行，任何按行号来的操作（跳转、生成 plan）
 * 都必须先把它摘掉。depth 只影响显示，真正的 depth / kind 由 tree.ts 在提交时定。
 */
function makeDraft(parent: MindNode, index: number): MindNode {
  const draft: MindNode = {
    id: DRAFT_ID,
    text: '',
    depth: parent.depth + 1,
    kind: 'heading',
    children: [],
    parent,
    titleLine: -1,
    bodyEnd: -1,
    blockStart: -1,
    blockEnd: -1,
    collapsed: false,
  }
  parent.children.splice(index, 0, draft)
  return draft
}
