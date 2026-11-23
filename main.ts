/**
 * 镜语剧本编辑器 — Obsidian 插件主入口
 *
 * 四源整合架构：
 *   景启 AI 原型 → 剧本语义系统（五类 Modevol + 六类剧本段落）
 *   any-menu    → 模板字典 + 命令面板快速输入
 *   outline-mindmap → 大纲侧栏 View + heading 树
 *   Obsidian Canvas → JSON Canvas 1.0 直接读写
 *
 * 编辑器增强：
 *   CodeMirror 6 registerEditorExtension → 段首标记装饰器 + 整行着色边框
 *   registerMarkdownPostProcessor       → Reading view 同样着色
 *
 * 画布：
 *   白板：原生 .canvas（JSON Canvas 1.0）
 *   无限画布：镜语 .nboard（Nestboard 兼容格式）
 *   剧本 → 大纲布局 → NBoard 卡片与连线（项目→场景组→段落节点）
 */

import {
  addIcon,
  App,
  Editor,
  getLanguage,
  MarkdownPostProcessorContext,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
  TFile,
} from "obsidian"

import { scriptDecorations } from "./src/editor/scriptDecorations"
import { scriptPostProcessor } from "./src/editor/scriptPostProcess"
import { annotationMarkers } from "./src/omm/doc/markers"
import {
  generateCanvasFromContent,
  generateNBoardFromContent,
  serializeCanvas,
} from "./src/editor/canvasGenerator"
import { ScriptOutlineView, OUTLINE_VIEW_TYPE } from "./src/views/ScriptOutlineView"
import { MINDMAP_VIEW_TYPE } from "./src/views/MindmapView"
import { LensBoardView, BOARD_VIEW_TYPE } from "./src/views/BoardView"
import { NestMindView, NESTMIND_VIEW_TYPE } from "./src/views/NestMindView"
import { OmmHost } from "./src/omm/OmmHost"
import { normalizeStyleData } from "./src/omm/settings/StyleStore"
import { renderContextMenuSettings } from "./src/omm/settings/SettingsTab"
import { normalizeNodeMenu, normalizeCanvasMenu } from "./src/omm/settings/contextMenu"
import {
  MindmapView as OmmMindmapView,
  VIEW_TYPE_MINDMAP as OMM_VIEW_TYPE,
} from "./src/omm/view/MindmapView"
import {
  DictionaryEntryModal,
  DictionaryPanelModal,
  TransformPickerModal,
} from "./src/ui/DictionaryPanel"
import {
  normalizeCustomDictionary,
  type CustomDictionaryEntry,
} from "./src/core/dictionary"
import { OutlineStore } from "./src/views/OutlineStore"
import { RailManager, DEFAULT_RAIL_SETTINGS, type RailSettings } from "./src/editor/OutlineRail"
import { stringifyNBoard } from "./src/core/format/nboard"
import { createNestMind, stringifyNestMind } from "./src/core/format/nestmind"
import { setLocale } from "./src/mindmap/upstream/i18n"
import {
  DEFAULT_TAG_SETTINGS,
  normalizeTagSettings,
  normalizeMarker,
  resolveTags,
  validateCustomMarker,
  type CustomTagDef,
  type TagSettings,
} from "./src/core/tags"
import { setTagConfig, tagConfigEffect } from "./src/editor/tagRuntime"
import { serializeTree } from "./src/core/outline"
import {
  buildScriptScaffold,
  scriptTemplates,
  type ScriptTemplate,
} from "./src/templates/scriptTemplates"
import {
  attachBlockId,
  findBlockAtLine,
  generateBlockId,
  injectBlockIds,
  splitBlocks,
} from "./src/core/blocks"
import { indexAnchors } from "./src/core/anchor"
import { applyRepair, resolveNodeRef, type NodeRef } from "./src/core/ref"

interface LensSidecar {
  version?: number
  refs?: NodeRef[]
  [key: string]: unknown
}

interface LenscriptSettings {
  defaultModevolLabel: string    // "自定义说明" 的覆盖名
  showOutlineOnOpen: boolean      // 打开剧本文件时自动展开大纲
  canvasSubpath: string           // 原生白板 .canvas 的保存目录
  rail: RailSettings              // 编辑器边缘大纲导轨
  boardFolder: string             // 无限画布 .nboard 的保存目录
  boardGridSize: number            // 无限画布 .nboard 的吸附网格
  nestmindFolder: string           // 新建 NestMind 脑图（.nestmind）的默认保存目录
  railMinMigrated?: boolean       // 旧默认 minHeadings=3 的一次性迁移标记
  tags: TagSettings               // 标签组：官方两组 + 自定义
  dictionary: CustomDictionaryEntry[] // 快捷输入：自定义词典条目
  /** 导图的阅读 / 编辑模式（所有导图共用，重启后保持）。 */
  mindmapViewMode?: "edit" | "read"
  /** 导图样式（全局 + 单篇）。结构不透明，读的时候交给 normalizeStyleData 收拢。 */
  mindmapStyles?: unknown
  /** 导图右键菜单（节点上 / 空白处）。存的是按钮 id 数组，读的时候交给 normalize*Menu 收拢。 */
  mindmapNodeMenu?: unknown
  mindmapCanvasMenu?: unknown
}

const DEFAULT_SETTINGS: LenscriptSettings = {
  defaultModevolLabel: "自定义说明",
  showOutlineOnOpen: true,
  canvasSubpath: "_canvas",
  rail: { ...DEFAULT_RAIL_SETTINGS },
  boardFolder: "boards",
  boardGridSize: 16,
  nestmindFolder: "mindmaps",
  tags: { ...DEFAULT_TAG_SETTINGS, custom: [] },
  dictionary: [],
}

// 自定义 icon（inline SVG）
const LENSCRIPT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`

export default class LenscriptPlugin extends Plugin {
  settings: LenscriptSettings = DEFAULT_SETTINGS
  outlineStore!: OutlineStore
  railManager!: RailManager
  ommHost!: OmmHost
  private lastGlobalError: string | null = null

  async onload(): Promise<void> {
    await this.loadSettings()
    addIcon("lenscript", LENSCRIPT_ICON)
    setTagConfig(this.settings.tags)
    try {
      setLocale(getLanguage())
    } catch {
      // 语言检测失败时保持 upstream 默认英文
    }

    // 捕获全局异常，诊断文件里能看到（不依赖开发者控制台）
    this.registerDomEvent(window, "error", (ev: ErrorEvent) => {
      this.lastGlobalError = `${ev.message}\n${ev.error?.stack ?? ""}`.trim()
    })
    this.registerDomEvent(window, "unhandledrejection", (ev: PromiseRejectionEvent) => {
      const reason = ev.reason
      this.lastGlobalError =
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    })

    // === OutlineStore（M2 同源双视图数据层） ===
    this.outlineStore = new OutlineStore(this.app)

    // === 编辑器增强 ===
    // CodeMirror 6 装饰器（Live Preview / Source mode）
    // scriptDecorations：段首剧本标记徽章
    // annotationMarkers：导图行尾注解（外框 / 标注 / 关联线…）换成小图标
    this.registerEditorExtension([scriptDecorations, annotationMarkers()])

    // Markdown 后处理器（Reading view）
    this.registerMarkdownPostProcessor(
      (el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
        scriptPostProcessor(el)
      },
    )

    // === 大纲 + 导图 + 无限画布（统一内核三视图） ===
    this.registerView(OUTLINE_VIEW_TYPE, (leaf) => new ScriptOutlineView(leaf, this.outlineStore, (path, line) => {
      // 大纲点某一行：如果导图正开着同一篇笔记，就定位过去并展开
      const view = this.getOmmView()
      if (view && view.filePath === path) view.revealLine(line)
    }))
    // 旧版画布导图已并入 OMM 导图：不再注册视图，只保留类型常量用于清理历史标签页
    this.registerView(BOARD_VIEW_TYPE, (leaf) => new LensBoardView(leaf))
    this.registerView(NESTMIND_VIEW_TYPE, (leaf) => new NestMindView(leaf))
    // `.nboard` 直接交给镜语无限画布视图（与 Nestboard 文件格式兼容）
    this.registerExtensions(["nboard"], BOARD_VIEW_TYPE)
    // `.nestmind` 拥有独立的脑图编辑视图
    this.registerExtensions(["nestmind"], NESTMIND_VIEW_TYPE)

    // === 统一导图（OMM 内核，阅读 / 编辑双模式） ===
    this.ommHost = new OmmHost(this.app, {
      styles: normalizeStyleData(this.settings.mindmapStyles),
      persistStyles: () => {
        this.settings.mindmapStyles = this.ommHost.styles.toData()
        void this.saveSettings()
      },
      // 右键菜单与镜语设置同存一份 data.json，重启后保留
      persistMenus: () => {
        this.settings.mindmapNodeMenu = this.ommHost.settings.nodeMenu
        this.settings.mindmapCanvasMenu = this.ommHost.settings.canvasMenu
        void this.saveSettings()
      },
    })
    // 把上次保存的菜单按钮还原到宿主设置里（字段缺失时 normalize 会回退默认）
    this.ommHost.settings.nodeMenu = normalizeNodeMenu(this.settings.mindmapNodeMenu)
    this.ommHost.settings.canvasMenu = normalizeCanvasMenu(this.settings.mindmapCanvasMenu)
    this.ommHost.mindmapViewMode = this.settings.mindmapViewMode ?? "edit"
    // 跟随活动笔记：切到哪篇，开着的导图就自动换成哪篇并适应画布
    this.ommHost.settings.mapMode = "follow"
    this.ommHost.onMindmapViewModeChange((mode) => {
      this.settings.mindmapViewMode = mode
      void this.saveSettings()
    })
    this.registerView(OMM_VIEW_TYPE, (leaf) => new OmmMindmapView(leaf, this.ommHost))

    // === 编辑器边缘标题导轨 ===
    this.railManager = new RailManager(this.app, this, () => this.settings.rail)

    // vault modify → store 重建树（去抖后 emit → 双视图刷新）
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const active = this.app.workspace.getActiveFile()
        if (file === active) this.outlineStore.handleFileModify()
      }),
    )

    // === 命令 ===
    this.registerCommands()

    // === 功能区按钮 + 文件长按/右键菜单入口 ===
    this.registerFeatureEntry()

    // === 设置页 ===
    this.addSettingTab(new LenscriptSettingTab(this.app, this))

    // === 启动 ===
    this.app.workspace.onLayoutReady(() => {
      // 移动端没有 hover，浮动大纲导轨会遮挡正文，且无法预览
      if (!Platform.isMobile) this.railManager.start()
      this.healMindmapLeaves()
      if (this.settings.showOutlineOnOpen) this.activateOutlineView()
      this.warnLegacyPlugins()
    })
  }

  /** 清掉旧版画布导图残留的叶子（视图已不注册，留着只会显示一块空面板） */
  private healMindmapLeaves(): void {
    this.app.workspace.detachLeavesOfType(MINDMAP_VIEW_TYPE)
  }

  onunload(): void {
    this.railManager?.dispose()
    this.app.workspace.detachLeavesOfType(OUTLINE_VIEW_TYPE)
    this.app.workspace.detachLeavesOfType(MINDMAP_VIEW_TYPE)
    this.app.workspace.detachLeavesOfType(BOARD_VIEW_TYPE)
    this.app.workspace.detachLeavesOfType(NESTMIND_VIEW_TYPE)
  }

  /** 旧插件仍在启用时提示一次，避免视图/命令/快捷键互相打架 */
  private warnLegacyPlugins(): void {
    const enabled = (this.app as any)?.plugins?.enabledPlugins
    const legacy = ["nestboard", "gogoga-mindmap", "gogoga-outline"]
    if (!(enabled instanceof Set)) return
    const stillOn = legacy.filter((id) => enabled.has(id))
    if (!stillOn.length) return
    new Notice(
      `检测到旧插件仍在启用：${stillOn.join("、")}。` +
        "它们与镜语的大纲/导图/无限画布视图可能冲突，建议在「设置 → 第三方插件」中停用后再使用镜语。",
      8000,
    )
  }

  private registerCommands(): void {
    // ---- 大纲视图 ----
    this.addCommand({
      id: "toggle-outline",
      name: "视图 · 大纲",
      icon: "list-tree",
      callback: () => this.toggleOutlineView(),
    })

    // ---- 快捷输入 / 选中文本转换（any-menu 内核） ----
    this.addCommand({
      id: "open-dictionary",
      name: "快捷输入 · 词典面板（Alt+A）",
      icon: "zap",
      hotkeys: [{ modifiers: ["Alt"], key: "A" }],
      callback: () => new DictionaryPanelModal(this.app, this.settings.dictionary).open(),
    })

    this.addCommand({
      id: "transform-selection",
      name: "转换 · 选中文本",
      icon: "wand-2",
      callback: () => new TransformPickerModal(this.app).open(),
    })

    // ---- 创建新项目 ----
    this.addCommand({
      id: "new-script",
      name: "新建剧本项目",
      icon: "document",
      editorCallback: (editor: Editor, _view) => {
        new NewScriptModal(this.app, this, editor).open()
      },
    })

    // ---- 插入模板（any-menu 风格）----
    for (const tpl of scriptTemplates) {
      this.addCommand({
        id: `insert-template-${tpl.id}`,
        name: `插入 · ${tpl.title}`,
        editorCallback: (editor: Editor) => {
          editor.replaceSelection(tpl.content)
          new Notice(`已插入：${tpl.title}`)
        },
      })
    }

    // ---- 从剧本生成官方白板或无限画布 ----
    this.addCommand({
      id: "generate-canvas",
      name: "白板 · 从当前剧本生成（.canvas）",
      icon: "layout-dashboard",
      editorCallback: async (_editor: Editor, view) => {
        if (!view?.file) {
          new Notice("请先打开一个剧本 Markdown 文件")
          return
        }
        await this.generateCanvas(view.file)
      },
    })
    this.addCommand({
      id: "generate-nboard",
      name: "无限画布 · 从当前剧本生成（.nboard）",
      icon: "layout-grid",
      editorCallback: async (_editor: Editor, view) => {
        if (!view?.file) {
          new Notice("请先打开一个剧本 Markdown 文件")
          return
        }
        await this.generateNBoard(view.file)
      },
    })

    // ---- 快速搜索模板 ----
    this.addCommand({
      id: "search-template",
      name: "搜索剧本模板",
      icon: "search",
      editorCallback: (editor: Editor) => {
        new TemplatePickerModal(this.app, this, editor).open()
      },
    })

    // ---- M1 锚点系统 ----
    this.addCommand({
      id: "inject-block-ids",
      name: "锚点 · 为当前文档注入块 ID",
      icon: "hash",
      editorCallback: (editor: Editor) => {
        const result = injectBlockIds(editor.getValue())
        if (result.injected.length === 0) {
          new Notice("当前文档所有可锚定块都已有块 ID")
          return
        }
        const last = editor.lineCount() - 1
        editor.transaction({
          changes: [
            {
              from: { line: 0, ch: 0 },
              to: { line: last, ch: editor.getLine(last).length },
              text: result.markdown,
            },
          ],
        })
        new Notice(`已注入 ${result.injected.length} 个块 ID`)
      },
    })

    this.addCommand({
      id: "copy-block-ref",
      name: "锚点 · 复制当前块引用",
      icon: "link",
      editorCallback: (editor: Editor, view) => {
        const file = view?.file
        if (!file) {
          new Notice("请先打开一个 Markdown 文件")
          return
        }

        const blocks = splitBlocks(editor.getValue())
        const cursor = editor.getCursor()
        const block = findBlockAtLine(blocks, cursor.line)
        if (!block) {
          new Notice("光标不在可锚定的块内")
          return
        }

        let blockId = block.blockId
        if (!blockId) {
          const used = new Set<string>()
          for (const b of blocks) {
            if (b.blockId) used.add(b.blockId)
          }
          blockId = generateBlockId(
            `${block.kind}:${block.fingerprint}:${block.index}`,
            used,
          )
          const lineText = editor.getLine(block.endLine)
          editor.replaceRange(
            ` ^${blockId}`,
            { line: block.endLine, ch: lineText.length },
          )
        }

        const linkPath = file.path.replace(/\.md$/i, "")
        const link = `[[${linkPath}#^${blockId}]]`
        navigator.clipboard
          .writeText(link)
          .then(() => new Notice(`已复制：${link}`))
          .catch(() => new Notice(`复制失败，请手动复制：${link}`))
      },
    })

    this.addCommand({
      id: "repair-refs",
      name: "锚点 · 校验并修复引用（.lens.json）",
      icon: "wrench",
      editorCallback: async (_editor: Editor, view) => {
        if (!view?.file) {
          new Notice("请先打开一个 Markdown 文件")
          return
        }
        await this.validateRefs(view.file)
      },
    })

    // ---- 统一导图（阅读 / 编辑双模式） ----
    this.addCommand({
      id: "view-mindmap",
      name: "视图 · 导图",
      icon: "layout-grid",
      callback: () => void this.activateOmmView(),
    })
    this.addCommand({
      id: "view-mindmap-mode",
      name: "视图 · 导图 · 切换阅读/编辑模式",
      icon: "book-open",
      callback: () => {
        const view = this.getOmmView()
        if (!view) {
          new Notice("请先打开导图视图：命令「视图 · 导图」")
          return
        }
        view.toggleMode()
      },
    })
    this.addCommand({
      id: "view-mindmap-close",
      name: "视图 · 导图 · 关闭全部",
      icon: "x",
      callback: () => {
        this.app.workspace.detachLeavesOfType(OMM_VIEW_TYPE)
      },
    })

    // ---- 导图内的常用动作（与工具栏同一套能力，命令面板也能直达） ----
    const omm = (fn: (view: OmmMindmapView) => void) => {
      const view = this.getOmmView()
      if (!view) {
        new Notice("请先打开导图视图：命令「视图 · 导图」")
        return
      }
      fn(view)
    }
    this.addCommand({
      id: "mm-search",
      name: "导图 · 搜索节点与正文",
      icon: "search",
      callback: () => omm((v) => v.openFind()),
    })
    this.addCommand({
      id: "mm-export-svg",
      name: "导图 · 导出 SVG",
      icon: "image",
      callback: () => omm((v) => void v.exportAs("svg")),
    })
    this.addCommand({
      id: "mm-export-png",
      name: "导图 · 导出 PNG",
      icon: "image-plus",
      callback: () => omm((v) => void v.exportAs("png")),
    })

    this.addCommand({
      id: "apply-outline-to-markdown",
      name: "大纲 · 把当前结构回写 Markdown",
      icon: "refresh-cw",
      editorCallback: async (_editor: Editor, view) => {
        if (!view?.file) {
          new Notice("请先打开一个 Markdown 文件")
          return
        }
        const state = this.outlineStore.state
        if (state.roots.length === 0) {
          new Notice("没有可回写的大纲结构")
          return
        }
        const original = await this.app.vault.read(view.file)
        const serialized = serializeTree(state.roots, original)
        if (serialized.trim() === original.trim()) {
          new Notice("Markdown 已与大纲一致，无需改动")
          return
        }
        const ok = confirm(
          "这将用当前大纲树重写 Markdown 文件（heading 深度、marker 缩进可能变化）。\n继续前建议先备份。\n确定继续？",
        )
        if (!ok) return
        await this.app.vault.modify(view.file, serialized)
        new Notice("已将大纲结构回写 Markdown")
      },
    })

    // ---- M3 融合：导轨 + 原生白板/无限画布 ----
    this.addCommand({
      id: "toggle-outline-rail",
      name: "导轨 · 显示/隐藏编辑器大纲导轨",
      icon: "panel-right",
      callback: async () => {
        this.settings.rail.enabled = !this.settings.rail.enabled
        await this.saveSettings()
        this.railManager.refreshSettings()
        new Notice(this.settings.rail.enabled ? "已显示大纲导轨" : "已隐藏大纲导轨")
      },
    })

    this.addCommand({
      id: "new-board",
      name: "白板 · 新建白板（.canvas）",
      icon: "layout-dashboard",
      callback: () => this.createBoard(),
    })

    this.addCommand({
      id: "new-nestmind",
      name: "脑图 · 新建 NestMind（.nestmind）",
      icon: "git-fork",
      callback: () => this.createNestMindFile(),
    })

    this.addCommand({
      id: "board-add-mind",
      name: "无限画布 · 插入空白脑图卡片",
      icon: "git-fork",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        view.newEmbeddedMindAtCenter()
      },
    })

    this.addCommand({
      id: "board-insert-mind-file",
      name: "无限画布 · 插入 .nestmind 脑图文件",
      icon: "file-plus",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        void view.insertMindFileAtCenter()
      },
    })

    this.addCommand({
      id: "board-export-mind",
      name: "无限画布 · 把选中的脑图卡片导出为 .nestmind",
      icon: "save",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        void view.exportSelectedMind()
      },
    })

    this.addCommand({
      id: "board-export-png",
      name: "无限画布 · 导出为 PNG",
      icon: "image",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        void view.exportBoardPng()
      },
    })

    this.addCommand({
      id: "board-search",
      name: "无限画布 · 搜索卡片",
      icon: "search",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        view.openSearch()
      },
    })

    this.addCommand({
      id: "board-present",
      name: "无限画布 · 开始演示",
      icon: "play",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        view.startPresentation()
      },
    })

    this.addCommand({
      id: "board-readonly",
      name: "无限画布 · 切换只读模式",
      icon: "lock",
      callback: () => {
        const view = this.getBoardView()
        if (!view) {
          new Notice("请先打开一个无限画布文件（.nboard）")
          return
        }
        view.toggleReadOnly()
      },
    })

    this.addCommand({
      id: "open-home-board",
      name: "无限画布 · 打开 Home 无限画布",
      icon: "home",
      callback: async () => {
        const folder = (this.settings.boardFolder.trim() || "boards").replace(/\/+$/, "")
        const candidates = [`${folder}/Home.nboard`, "boards/Home.nboard", "Boards/Home.nboard"]
        const path = candidates.find((candidate) =>
          this.app.vault.getAbstractFileByPath(candidate) instanceof TFile,
        )
        if (path) {
          await this.openNBoard(path, false)
        } else {
          new Notice("还没有 Home 无限画布（boards/Home.nboard 或 Boards/Home.nboard）")
        }
      },
    })

    this.addCommand({
      id: "lenscript-diagnostics",
      name: "镜语 · 导出诊断文件",
      icon: "stethoscope",
      callback: () => void this.runDiagnostics(),
    })

    this.addCommand({
      id: "open-feature-menu",
      name: "镜语 · 打开功能面板",
      icon: "lenscript",
      callback: () => this.openFeatureMenu(null, this.app.workspace.getActiveFile()),
    })
  }

  // ================= 功能区按钮 / 文件菜单 =================

  /** 左侧功能区常驻按钮；文件树长按（移动端）/ 右键（桌面端）菜单入口 */
  private registerFeatureEntry(): void {
    this.addRibbonIcon("lenscript", "镜语 · 插件功能", (evt) => {
      this.openFeatureMenu(evt, this.app.workspace.getActiveFile())
    })

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const target = file instanceof TFile ? file : null
        menu.addItem((item) => {
          item.setTitle("镜语 · 插件功能").setIcon("lenscript")
          // setSubmenu 在低版本 API 中可能不存在，做一次能力探测
          const withSub = item as unknown as { setSubmenu?: () => Menu }
          const sub = typeof withSub.setSubmenu === "function" ? withSub.setSubmenu() : null
          if (sub) {
            this.fillFeatureMenu(sub, target)
          } else {
            item.onClick(() => this.openFeatureMenu(null, target))
          }
        })
      }),
    )
  }

  private openFeatureMenu(evt: MouseEvent | null, file: TFile | null): void {
    const menu = new Menu()
    this.fillFeatureMenu(menu, file)
    if (evt) {
      menu.showAtMouseEvent(evt)
    } else {
      menu.showAtPosition({
        x: Math.round(window.innerWidth / 2),
        y: Math.max(56, Math.round(window.innerHeight * 0.12)),
      })
    }
  }

  private fillFeatureMenu(menu: Menu, file: TFile | null): void {
    const add = (title: string, icon: string, commandId: string): void => {
      menu.addItem((item) =>
        item.setTitle(title).setIcon(icon).onClick(() => this.runCommand(commandId)),
      )
    }

    // 针对被点击的文件给出直达动作
    if (file) {
      if (file.extension === "md") {
        menu.addItem((item) =>
          item
            .setTitle(`「${file.basename}」剧本大纲`)
            .setIcon("list-tree")
            .onClick(() => void this.activateOutlineView()),
        )
        menu.addItem((item) =>
          item
            .setTitle(`「${file.basename}」导图`)
            .setIcon("git-fork")
            .onClick(() => void this.activateOmmView(file.path)),
        )
        menu.addItem((item) =>
          item
            .setTitle(`从「${file.basename}」生成官方白板（.canvas）`)
            .setIcon("layout-dashboard")
            .onClick(() => void this.generateCanvas(file)),
        )
        menu.addItem((item) =>
          item
            .setTitle(`从「${file.basename}」生成无限画布（.nboard）`)
            .setIcon("layout-grid")
            .onClick(() => void this.generateNBoard(file)),
        )
      } else if (file.extension === "nboard") {
        menu.addItem((item) =>
          item
            .setTitle(`打开无限画布「${file.basename}」`)
            .setIcon("layout-dashboard")
            .onClick(() => void this.app.workspace.getLeaf(false).openFile(file)),
        )
      } else if (file.extension === "nestmind") {
        menu.addItem((item) =>
          item
            .setTitle(`打开脑图「${file.basename}」`)
            .setIcon("git-fork")
            .onClick(() => void this.app.workspace.getLeaf(false).openFile(file)),
        )
      }
      menu.addSeparator()
    }

    add("快捷输入 · 词典面板（Alt+A）", "zap", "open-dictionary")
    add("转换 · 选中文本", "wand-2", "transform-selection")
    menu.addSeparator()
    add("剧本大纲", "list-tree", "toggle-outline")
    add("导图视图", "git-fork", "view-mindmap")
    add("搜索剧本模板", "search", "search-template")
    add("新建剧本项目", "document", "new-script")
    menu.addSeparator()
    add("新建白板（.canvas）", "layout-dashboard", "new-board")
    add("新建 NestMind 脑图（.nestmind）", "git-fork", "new-nestmind")
    add("打开 Home 无限画布", "home", "open-home-board")
    add("从当前剧本生成官方白板（.canvas）", "layout-dashboard", "generate-canvas")
    add("从当前剧本生成无限画布（.nboard）", "layout-grid", "generate-nboard")
    menu.addSeparator()
    add("导出诊断文件", "stethoscope", "lenscript-diagnostics")
  }

  private runCommand(id: string): void {
    // 类型定义未暴露 app.commands，运行时可用
    const commands = (this.app as unknown as {
      commands?: { executeCommandById: (id: string) => boolean }
    }).commands
    commands?.executeCommandById(`${this.manifest.id}:${id}`)
  }

  private collectDiagnostics(): Record<string, unknown> {
    const active = this.app.workspace.getActiveFile()
    const mindmapLeaves = this.app.workspace
      .getLeavesOfType(OMM_VIEW_TYPE)
      .map((leaf) => {
        const view = leaf.view
        return {
          viewType: view?.getViewType?.() ?? null,
          isOurMindmapView: view instanceof OmmMindmapView,
          readMode: this.ommHost.getMindmapViewMode(),
        }
      })
    return {
      generatedAt: new Date().toISOString(),
      pluginVersion: this.manifest.version,
      platform: `${navigator.platform} / ${navigator.userAgent}`,
      activeFile: active?.path ?? null,
      lastOpenFiles: this.app.workspace.getLastOpenFiles().slice(0, 8),
      outlineViewCount: this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE).length,
      outlineRoots: this.outlineStore.state.roots.length,
      outlineFirstNodes: this.outlineStore.state.roots
        .slice(0, 5)
        .map((n) => ({ kind: n.kind, label: n.label, startLine: n.startLine })),
      mindmapLeaves,
      boardViewCount: this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE).length,
      boardDebug: (() => {
        const board = this.getBoardView()
        return board ? board.debugInfo() : null
      })(),
      railSettings: this.settings.rail,
      legacyPluginsEnabled: (() => {
        const enabled = (this.app as any)?.plugins?.enabledPlugins
        if (!(enabled instanceof Set)) return []
        return ["nestboard", "gogoga-mindmap", "gogoga-outline"].filter((id) =>
          enabled.has(id),
        )
      })(),
      lastGlobalError: this.lastGlobalError,
    }
  }

  private async runDiagnostics(): Promise<void> {
    const info = this.collectDiagnostics()
    const path = "_lenscript-diagnostics.md"
    const content =
      "# 镜语诊断\n\n" +
      "> 这个文件由「镜语 · 导出诊断文件」生成，可以直接把内容发给开发者。\n\n" +
      "```json\n" +
      JSON.stringify(info, null, 2) +
      "\n```\n"
    try {
      const existing = this.app.vault.getAbstractFileByPath(path)
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content)
      } else {
        await this.app.vault.create(path, content)
      }
      const file = this.app.vault.getAbstractFileByPath(path)
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file)
      }
      new Notice(`诊断已写入：${path}，请把该文件内容发我`, 8000)
    } catch (e) {
      new Notice(`写入诊断失败：${e instanceof Error ? e.message : String(e)}`, 10000)
    }
  }

  // ============ 原生白板与无限画布 ============

  private async uniquePath(folder: string, base: string, ext: string): Promise<string> {
    const dir = folder.replace(/\/+$/, "")
    let n = 1
    let path = `${dir ? dir + "/" : ""}${base}.${ext}`
    while (this.app.vault.getAbstractFileByPath(path)) {
      n++
      path = `${dir ? dir + "/" : ""}${base} ${n}.${ext}`
    }
    return path
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing) return
    const parts = path.split("/").filter(Boolean)
    let cur = ""
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur)
        } catch {
          // 并发/已存在时忽略
        }
      }
    }
  }

  private async createBoard(): Promise<void> {
    try {
      const folder = this.settings.canvasSubpath.trim() || "_canvas"
      await this.ensureFolder(folder)
      const path = await this.uniquePath(folder, "未命名白板", "canvas")
      await this.app.vault.create(path, serializeCanvas({ nodes: [], edges: [] }))
      await this.openCanvas(path, false)
      new Notice(`已创建白板（.canvas）：${path}`)
    } catch (e) {
      new Notice(`创建白板失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async createNestMindFile(): Promise<void> {
    try {
      const folder = this.settings.nestmindFolder.trim() || "mindmaps"
      await this.ensureFolder(folder)
      const path = await this.uniquePath(folder, "未命名脑图", "nestmind")
      const title = path.split("/").pop()?.replace(/\.nestmind$/, "") ?? "未命名脑图"
      const file = await this.app.vault.create(path, stringifyNestMind(createNestMind(title)))
      await this.app.workspace.getLeaf(false).openFile(file)
      new Notice(`已创建 NestMind 脑图（.nestmind）：${path}`)
    } catch (e) {
      new Notice(`创建 NestMind 脑图失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 同目录 <basename>.lens.json 路径 */
  private sidecarPath(file: TFile): string {
    const parent = file.parent?.path
    if (!parent || parent === "/") return `${file.basename}.lens.json`
    return `${parent}/${file.basename}.lens.json`
  }

  /**
   * 校验 .lens.json 中的引用：
   *   - 块 ID 命中 → ok
   *   - 块 ID 失效 → 按 heading 路径 + 文本指纹重定位（moved）
   *   - 旧块 ID 被删但块被找回 → 把旧 ID 重新挂回目标块
   *   - 彻底找不到 → broken
   */
  private async validateRefs(file: TFile): Promise<void> {
    const sidecarPath = this.sidecarPath(file)
    const sidecar = this.app.vault.getAbstractFileByPath(sidecarPath)
    if (!(sidecar instanceof TFile)) {
      new Notice(`未找到引用文件：${sidecarPath}`)
      return
    }

    let data: LensSidecar
    try {
      data = JSON.parse(await this.app.vault.read(sidecar)) as LensSidecar
    } catch {
      new Notice("引用文件不是合法 JSON")
      return
    }
    if (!Array.isArray(data.refs) || data.refs.length === 0) {
      new Notice("引用文件中没有 refs")
      return
    }

    const counts = { ok: 0, moved: 0, broken: 0 }
    let repaired = 0
    let reattached = 0
    let refsChanged = false

    const docs = new Map<
      string,
      { file: TFile; markdown: string; index: ReturnType<typeof indexAnchors>; dirty: boolean }
    >()
    const reattachedKeys = new Set<string>()

    for (const ref of data.refs) {
      if (!ref || typeof ref.file !== "string") {
        counts.broken++
        continue
      }

      let targetPath = ref.file || file.path
      if (!/\.[a-z0-9]+$/i.test(targetPath)) targetPath += ".md"

      let doc = docs.get(targetPath)
      if (!doc) {
        const target = this.app.vault.getAbstractFileByPath(targetPath)
        if (!(target instanceof TFile)) {
          counts.broken++
          continue
        }
        const markdown = await this.app.vault.read(target)
        doc = {
          file: target,
          markdown,
          index: indexAnchors(markdown),
          dirty: false,
        }
        docs.set(targetPath, doc)
      }

      const resolution = resolveNodeRef(doc.markdown, ref, doc.index)
      counts[resolution.status]++

      if (resolution.repaired && applyRepair(ref, resolution)) {
        repaired++
        refsChanged = true
      }

      if (
        resolution.status === "moved" &&
        resolution.block &&
        !resolution.block.blockId &&
        ref.blockId &&
        !doc.index.byId.has(ref.blockId)
      ) {
        const key = `${targetPath}:${resolution.block.index}:${ref.blockId}`
        if (!reattachedKeys.has(key)) {
          reattachedKeys.add(key)
          doc.markdown = attachBlockId(
            doc.markdown,
            resolution.block.index,
            ref.blockId,
          )
          doc.dirty = true
          reattached++
        }
      }
    }

    for (const doc of docs.values()) {
      if (doc.dirty) await this.app.vault.modify(doc.file, doc.markdown)
    }
    if (refsChanged) {
      await this.app.vault.modify(sidecar, JSON.stringify(data, null, 2))
    }

    new Notice(
      `引用校验：${counts.ok} 有效 / ${counts.moved} 已移动 / ${counts.broken} 断链；` +
        `修复 ${repaired} 条，重挂块 ID ${reattached} 个`,
    )
  }

  private async activateOutlineView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)
    if (leaves.length === 0) {
      await this.app.workspace.getRightLeaf(false)?.setViewState({
        type: OUTLINE_VIEW_TYPE,
        active: true,
      })
    } else {
      // 视图已存在但侧栏可能是折叠的：显式展开，否则用户会以为命令没反应
      this.app.workspace.revealLeaf(leaves[0])
    }
    this.app.workspace.rightSplit?.expand?.()
  }

  private async toggleOutlineView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)
    if (leaves.length > 0) {
      leaves.forEach((l) => l.detach())
    } else {
      await this.activateOutlineView()
    }
  }

  /** 当前打开的导图实例（统一导图只有一种视图类型）。 */
  private getOmmView(): OmmMindmapView | null {
    const active = this.app.workspace.activeLeaf?.view
    if (active instanceof OmmMindmapView) return active
    for (const leaf of this.app.workspace.getLeavesOfType(OMM_VIEW_TYPE)) {
      if (leaf.view instanceof OmmMindmapView) return leaf.view
    }
    return null
  }

  private getBoardView(): LensBoardView | null {
    const active = this.app.workspace.activeLeaf?.view
    if (active instanceof LensBoardView) return active
    for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) {
      if (leaf.view instanceof LensBoardView) return leaf.view
    }
    return null
  }

  /** 打开统一导图。同一个标签页只保留一个实例；具体停在哪篇由视图自己跟随。 */
  private async activateOmmView(filePath?: string): Promise<void> {
    const active = this.app.workspace.getActiveFile()
    const file = filePath ?? active?.path ?? this.lastActiveMarkdown()
    if (!file) {
      new Notice("请先打开一个 Markdown 文件")
      return
    }
    this.app.workspace.detachLeavesOfType(OMM_VIEW_TYPE)
    await this.app.workspace.getLeaf("tab").setViewState({
      type: OMM_VIEW_TYPE,
      active: true,
      state: { file, pinned: true, commandMap: true },
    })
  }

  private lastActiveMarkdown(): string {
    const active = this.app.workspace.getActiveFile()
    if (active?.extension === "md") return active.path
    for (const path of this.app.workspace.getLastOpenFiles()) {
      if (path.endsWith(".md")) return path
    }
    return ""
  }

  /** 恢复旧入口：在剧本同目录生成 Obsidian 原生 Canvas。 */
  private async generateCanvas(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file)
      const canvas = generateCanvasFromContent(content, file)
      const folder = (file.parent?.path ?? "").replace(/\/+$/, "")
      const canvasPath = `${folder ? `${folder}/` : ""}${file.basename}.canvas`
      const canvasContent = serializeCanvas(canvas)
      const existing = this.app.vault.getAbstractFileByPath(canvasPath)
      const summary = `${canvasPath}（${canvas.nodes.length} 节点，${canvas.edges.length} 连线）`

      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, canvasContent)
        new Notice(`已更新官方白板（.canvas）：${summary}`)
      } else if (existing) {
        throw new Error(`目标路径不是文件：${canvasPath}`)
      } else {
        await this.app.vault.create(canvasPath, canvasContent)
        new Notice(`已生成官方白板（.canvas）：${summary}`)
      }
    } catch (e) {
      new Notice(`生成官方白板失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async generateNBoard(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file)
      const board = generateNBoardFromContent(content, file, {
        title: file.basename,
        gridSize: this.settings.boardGridSize,
      })
      const folder = this.settings.boardFolder.trim() || "boards"
      await this.ensureFolder(folder)
      const boardPath = `${folder.replace(/\/+$/, "")}/${file.basename}.nboard`
      const boardContent = stringifyNBoard(board)
      const existing = this.app.vault.getAbstractFileByPath(boardPath)
      const summary = `${boardPath}（${board.cards.length} 卡片，${board.edges.length} 连线）`

      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, boardContent)
        new Notice(`已更新无限画布（.nboard）：${summary}`)
      } else if (existing) {
        throw new Error(`目标路径不是文件：${boardPath}`)
      } else {
        await this.app.vault.create(boardPath, boardContent)
        new Notice(`已生成无限画布（.nboard）：${summary}`)
        // 首次生成：打开并适应全图；再次生成只覆盖内容，保留用户当前视角
        await this.openNBoard(boardPath, true)
      }
    } catch (e) {
      new Notice(`生成无限画布失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async openNBoard(path: string, fit: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    const opened = this.app.workspace
      .getLeavesOfType(BOARD_VIEW_TYPE)
      .find((leaf) => (leaf.view as LensBoardView).file?.path === path)
    const leaf = opened ?? this.app.workspace.getLeaf(false)
    await leaf.openFile(file)
    if (fit && leaf.view instanceof LensBoardView) leaf.view.zoomToFit()
  }

  /**
   * 打开原生白板文件。Canvas 视图没有公开 API，能拿到 zoomToFit 就调用，
   * 否则尝试内置命令；都失败也不影响画布内容，用户可手动适应。
   */
  private async openCanvas(path: string, fit: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    try {
      const opened = this.app.workspace
        .getLeavesOfType("canvas")
        .find((leaf) => (leaf.view as any)?.file?.path === path)
      const leaf = opened ?? this.app.workspace.getLeaf(false)
      await leaf.openFile(file)
      if (!fit) return
      const view = leaf.view as any
      const target = view?.canvas ?? view
      if (typeof target?.zoomToFit === "function") target.zoomToFit()
      else (this.app as any).commands?.executeCommandById?.("canvas:zoom-to-fit")
    } catch {
      /* 视图接口随 Obsidian 版本变化，失败时静默跳过 */
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData()
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data)
    this.settings.rail = {
      ...DEFAULT_RAIL_SETTINGS,
      ...((data && typeof data === "object" && data.rail) || {}),
    }
    this.settings.tags = normalizeTagSettings(
      data && typeof data === "object" ? data.tags : undefined,
    )
    this.settings.dictionary = normalizeCustomDictionary(
      data && typeof data === "object" ? data.dictionary : undefined,
    )

    let settingsChanged = false
    // 仅迁移旧默认目录；用户自定义目录原样保留。
    if (!data || typeof data !== "object" || !data.boardFolder || data.boardFolder === "Boards") {
      this.settings.boardFolder = "boards"
      settingsChanged = true
    }
    // 旧版本默认最少 3 个标题，导致新文档/短文档看不到导轨；一次性改成 1
    if (!this.settings.railMinMigrated) {
      if (this.settings.rail.minHeadings === 3) this.settings.rail.minHeadings = 1
      this.settings.railMinMigrated = true
      settingsChanged = true
    }
    if (settingsChanged) await this.saveData(this.settings)
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /** 标签组变更后：更新运行时索引，并让打开着的编辑器/阅读视图立即重绘 */
  applyTagSettings(): void {
    setTagConfig(this.settings.tags)
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) continue
      const cm = (view.editor as any).cm
      cm?.dispatch?.({ effects: tagConfigEffect.of(0) })
      ;(view.previewMode as any)?.rerender?.(true)
    }
  }
}

// ==========================================================================
// 设置页（抽屉式：先显示分类，进入分类后显示单页 + 返回）
// ==========================================================================
type SettingsSectionId = "basic" | "tags" | "dictionary" | "rail" | "mindmap" | "board" | "about"

interface SettingsSectionMeta {
  id: SettingsSectionId
  name: string
  desc: string
  icon: string
}

const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "basic", name: "基础", desc: "默认标签名、打开剧本时的大纲行为", icon: "pencil" },
  { id: "tags", name: "标签组", desc: "语义标签、剧本段落与自定义标签", icon: "tags" },
  { id: "dictionary", name: "快捷输入词典", desc: "Alt+A 面板里的模板与常用句式", icon: "book-open" },
  { id: "rail", name: "编辑器导轨", desc: "编辑区边缘的标题导轨与预览", icon: "panel-right" },
  { id: "mindmap", name: "思维导图", desc: "右键菜单按钮编排", icon: "network" },
  { id: "board", name: "画布", desc: "白板类画布（.canvas）与无限画布（.nboard）", icon: "layout-dashboard" },
  { id: "about", name: "关于与参考", desc: "旧插件共存检查、Markdown 速查", icon: "info" },
]

class LenscriptSettingTab extends PluginSettingTab {
  plugin: LenscriptPlugin
  /** null = 分类首页；否则是当前打开的那一页。 */
  private section: SettingsSectionId | null = null

  constructor(app: App, plugin: LenscriptPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass("ls-settings")
    if (this.section !== null) {
      this.renderSection(this.section)
      return
    }
    this.renderIndex()
  }

  /** 分类首页：一列可点的抽屉入口。 */
  private renderIndex(): void {
    const { containerEl } = this
    containerEl.createEl("h2", { text: "镜语剧本编辑器" })
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "设置按类别收进下面的抽屉：点一下进入，左上角返回。",
    })
    const list = containerEl.createDiv({ cls: "ls-settings-index" })
    for (const section of SETTINGS_SECTIONS) {
      const row = list.createDiv({ cls: "ls-settings-row" })
      row.tabIndex = 0
      row.setAttribute("role", "button")
      const icon = row.createDiv({ cls: "ls-settings-row-icon" })
      setIcon(icon, section.icon)
      const text = row.createDiv({ cls: "ls-settings-row-text" })
      text.createDiv({ cls: "ls-settings-row-name", text: section.name })
      text.createDiv({ cls: "ls-settings-row-desc", text: section.desc })
      const chevron = row.createDiv({ cls: "ls-settings-row-chevron" })
      setIcon(chevron, "chevron-right")
      const open = (): void => {
        this.section = section.id
        this.display()
        this.scrollToTop()
      }
      row.addEventListener("click", open)
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          open()
        }
      })
    }
  }

  /** 切页之后回到顶部；设置页真正的滚动容器不在 containerEl 上。 */
  private scrollToTop(): void {
    const scroller = this.containerEl.closest(".vertical-tab-content-container") as HTMLElement | null
    if (scroller) scroller.scrollTop = 0
    else this.containerEl.scrollTop = 0
  }

  /** 打开某一页：返回按钮 + 页头 + 该页内容。 */
  private renderSection(id: SettingsSectionId): void {
    const { containerEl } = this
    const meta = SETTINGS_SECTIONS.find((item) => item.id === id)
    const head = containerEl.createDiv({ cls: "ls-settings-head" })
    const back = head.createEl("button", { cls: "ls-settings-back clickable-icon" })
    setIcon(back, "arrow-left")
    back.setAttribute("aria-label", "返回设置分类")
    back.addEventListener("click", () => {
      this.section = null
      this.display()
      this.scrollToTop()
    })
    head.createEl("h2", { text: meta?.name ?? "设置" })
    if (meta) containerEl.createEl("p", { cls: "setting-item-description", text: meta.desc })

    switch (id) {
      case "basic":
        this.renderBasic()
        break
      case "tags":
        this.renderTags()
        break
      case "dictionary":
        this.renderDictionary()
        break
      case "rail":
        this.renderRail()
        break
      case "mindmap":
        this.renderMindmap()
        break
      case "board":
        this.renderBoard()
        break
      case "about":
        this.renderAbout()
        break
    }
  }

  private renderBasic(): void {
    const containerEl = this.containerEl

    new Setting(containerEl)
      .setName("#c 自定义说明的默认标签")
      .setDesc("段首输入 #c 后的默认显示名")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.defaultModevolLabel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModevolLabel = value || "自定义说明"
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("打开剧本时自动展开大纲")
      .setDesc("将剧本大纲侧栏固定在右侧")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showOutlineOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.showOutlineOnOpen = value
            await this.plugin.saveSettings()
          }),
      )
  }

  private renderTags(): void {
    const containerEl = this.containerEl
    const tagSettings = this.plugin.settings.tags
    const saveTags = async () => {
      await this.plugin.saveSettings()
      this.plugin.applyTagSettings()
    }

    new Setting(containerEl)
      .setName("语义标签组")
      .setDesc("#d 描述 · #e 例子 · #v 验证 · #t 迁移 · #c 自定义说明（用于拆分文章）")
      .addToggle((toggle) =>
        toggle.setValue(tagSettings.semanticEnabled).onChange(async (value) => {
          tagSettings.semanticEnabled = value
          await saveTags()
        }),
      )

    new Setting(containerEl)
      .setName("剧本段落组")
      .setDesc("#s 场景 · #a 动作 · #r 角色 · #l 对白 · #p 括注 · #x 转场（用于标注剧本）")
      .addToggle((toggle) =>
        toggle.setValue(tagSettings.scriptEnabled).onChange(async (value) => {
          tagSettings.scriptEnabled = value
          await saveTags()
        }),
      )

    containerEl.createEl("h4", { text: "自定义标签组" })
    if (tagSettings.custom.length === 0) {
      const empty = containerEl.createDiv({ cls: "setting-item-description" })
      empty.setText("还没有自定义标签。点击下方「添加自定义标签」创建，例如 #o → 观点。")
    }

    tagSettings.custom.forEach((tag, index) => {
      const setting = new Setting(containerEl)
        .setName(`${tag.marker} · ${tag.label}`)
        .setDesc(tag.enabled ? "已启用" : "已停用（不会在编辑器里标记）")
        .addToggle((toggle) =>
          toggle.setValue(tag.enabled).onChange(async (value) => {
            tag.enabled = value
            await saveTags()
          }),
        )
        .addText((text) =>
          text
            .setPlaceholder("显示文字")
            .setValue(tag.label)
            .onChange(async (value) => {
              tag.label = value.trim() || tag.marker
              await saveTags()
            }),
        )
        .addColorPicker((picker) =>
          picker.setValue(tag.color).onChange(async (value) => {
            tag.color = value
            await saveTags()
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("删除")
            .setWarning()
            .onClick(async () => {
              tagSettings.custom.splice(index, 1)
              await saveTags()
              this.display()
            }),
        )
      setting.settingEl.addClass("ls-tag-setting")
    })

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("添加自定义标签")
        .setCta()
        .onClick(() => {
          new CustomTagModal(this.app, this.plugin).open()
        }),
    )
  }

  private renderDictionary(): void {
    const containerEl = this.containerEl
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Alt+A 打开快捷输入面板。内置剧本模板之外，可在这里添加自己的模板 / 常用句式；面板按「分组 → 分类 → 条目」三级展示，右侧带 Markdown 预览。",
    })

    if (this.plugin.settings.dictionary.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: "还没有自定义条目。点击下方「添加自定义条目」创建。",
      })
    }

    this.plugin.settings.dictionary.forEach((entry, index) => {
      new Setting(containerEl)
        .setName(`${entry.title} · ${entry.category}`)
        .setDesc(entry.hint || (entry.enabled ? "已启用" : "已停用"))
        .addButton((button) =>
          button.setButtonText("编辑").onClick(() => {
            new DictionaryEntryModal(this.app, entry, async (updated) => {
              this.plugin.settings.dictionary[index] = updated
              await this.plugin.saveSettings()
              this.display()
            }).open()
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("删除")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.dictionary.splice(index, 1)
              await this.plugin.saveSettings()
              this.display()
            }),
        )
    })

    new Setting(containerEl)
      .addButton((button) =>
        button
          .setButtonText("添加自定义条目")
          .setCta()
          .onClick(() => {
            new DictionaryEntryModal(this.app, null, async (entry) => {
              this.plugin.settings.dictionary.push(entry)
              await this.plugin.saveSettings()
              this.display()
            }).open()
          }),
      )
      .addButton((button) =>
        button.setButtonText("打开快捷输入面板").onClick(() => {
          new DictionaryPanelModal(this.app, this.plugin.settings.dictionary).open()
        }),
      )
  }

  private renderRail(): void {
    const containerEl = this.containerEl
    const rail = this.plugin.settings.rail

    const refreshRail = async () => {
      await this.plugin.saveSettings()
      this.plugin.railManager.refreshSettings()
    }

    new Setting(containerEl)
      .setName("显示标题导轨")
      .setDesc("编辑器边缘的一列短横线；悬停出预览，停留展开完整大纲")
      .addToggle((toggle) =>
        toggle.setValue(rail.enabled).onChange(async (value) => {
          rail.enabled = value
          await refreshRail()
        }),
      )

    new Setting(containerEl)
      .setName("导轨位置")
      .setDesc("贴在编辑区的左侧还是右侧")
      .addDropdown((dd) =>
        dd
          .addOption("right", "右侧")
          .addOption("left", "左侧")
          .setValue(rail.side)
          .onChange(async (value) => {
            rail.side = value as RailSettings["side"]
            await refreshRail()
          }),
      )

    new Setting(containerEl)
      .setName("最少标题数")
      .setDesc("标题少于这个数量时隐藏导轨")
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setValue(rail.minHeadings)
          .setDynamicTooltip()
          .onChange(async (value) => {
            rail.minHeadings = value
            await refreshRail()
          }),
      )

    new Setting(containerEl)
      .setName("悬停显示章节预览")
      .setDesc("波峰所在的章节显示标题与开头几行正文")
      .addToggle((toggle) =>
        toggle.setValue(rail.showPreview).onChange(async (value) => {
          rail.showPreview = value
          await refreshRail()
        }),
      )

    new Setting(containerEl)
      .setName("展开方式")
      .setDesc("鼠标停留自动展开，或只用快捷键/命令展开")
      .addDropdown((dd) =>
        dd
          .addOption("dwell", "停留展开")
          .addOption("hotkey", "仅快捷键")
          .setValue(rail.expandMode)
          .onChange(async (value) => {
            rail.expandMode = value as RailSettings["expandMode"]
            await refreshRail()
          }),
      )

    new Setting(containerEl)
      .setName("停留延迟（毫秒）")
      .setDesc("鼠标在导轨上静止多久后展开")
      .addSlider((slider) =>
        slider
          .setLimits(150, 1200, 50)
          .setValue(rail.dwellDelay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            rail.dwellDelay = value
            await refreshRail()
          }),
      )

    new Setting(containerEl)
      .setName("面板宽度（px）")
      .setDesc("展开后的大纲面板宽度")
      .addSlider((slider) =>
        slider
          .setLimits(220, 520, 10)
          .setValue(rail.panelWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            rail.panelWidth = value
            await refreshRail()
          }),
      )

    new Setting(containerEl)
      .setName("面板显示层级")
      .setDesc("比这更深的标题不进入面板，但导轨上仍保留刻度")
      .addSlider((slider) =>
        slider
          .setLimits(1, 6, 1)
          .setValue(rail.panelMaxLevel)
          .setDynamicTooltip()
          .onChange(async (value) => {
            rail.panelMaxLevel = value
            await refreshRail()
          }),
      )

    // ================= 思维导图 · 右键菜单 =================
  }

  private renderMindmap(): void {
    // 导图视图用的是 OMM 内核，它的设置页没有单独注册；这里直接复用同一份编排界面。
    const containerEl = this.containerEl
    renderContextMenuSettings(containerEl, {
      nodeMenu: () => this.plugin.ommHost.settings.nodeMenu,
      setNodeMenu: (next) => { this.plugin.ommHost.settings.nodeMenu = next },
      canvasMenu: () => this.plugin.ommHost.settings.canvasMenu,
      setCanvasMenu: (next) => { this.plugin.ommHost.settings.canvasMenu = next },
      save: () => this.plugin.ommHost.saveSettings(),
      rerender: () => this.display(),
    })
  }

  private renderBoard(): void {
    const containerEl = this.containerEl

    new Setting(containerEl)
      .setName("白板类画布（.canvas）")
      .setDesc("Obsidian 原生 Canvas，由「白板 · 新建白板」创建。")
      .setHeading()

    new Setting(containerEl)
      .setName("白板保存目录")
      .setDesc("新建原生白板（.canvas）的落盘目录；与无限画布目录互不影响。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.canvasSubpath)
          .setPlaceholder("_canvas")
          .onChange(async (value) => {
            this.plugin.settings.canvasSubpath = value.trim() || "_canvas"
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("无限画布（.nboard）")
      .setDesc("镜语 Nestboard 兼容格式，由「无限画布 · 从当前剧本生成」创建，并使用镜语无限画布视图打开。")
      .setHeading()

    new Setting(containerEl)
      .setName("无限画布保存目录")
      .setDesc("从当前剧本生成无限画布（.nboard）的落盘目录。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.boardFolder)
          .setPlaceholder("boards")
          .onChange(async (value) => {
            this.plugin.settings.boardFolder = value.trim() || "boards"
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("无限画布默认网格")
      .setDesc("新生成 .nboard 的吸附网格（px）；不影响 Obsidian 原生 .canvas。")
      .addSlider((slider) =>
        slider
          .setLimits(4, 64, 4)
          .setValue(this.plugin.settings.boardGridSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.boardGridSize = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("NestMind 脑图（.nestmind）")
      .setDesc("独立 JSON 脑图格式，由「脑图 · 新建 NestMind」创建，也可插入无限画布。")
      .setHeading()

    new Setting(containerEl)
      .setName("NestMind 保存目录")
      .setDesc("新建 .nestmind 脑图的落盘目录；与白板、无限画布目录互不影响。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.nestmindFolder)
          .setPlaceholder("mindmaps")
          .onChange(async (value) => {
            this.plugin.settings.nestmindFolder = value.trim() || "mindmaps"
            await this.plugin.saveSettings()
          }),
      )
  }

  private renderAbout(): void {
    const containerEl = this.containerEl
    containerEl.createEl("h3", { text: "与旧插件的共存" })
    const enabled = (this.app as any)?.plugins?.enabledPlugins
    const legacy = ["nestboard", "gogoga-mindmap", "gogoga-outline"]
    const stillOn = enabled instanceof Set ? legacy.filter((id) => enabled.has(id)) : []
    const conflict = containerEl.createDiv({ cls: "setting-item-description" })
    conflict.setText(
      stillOn.length
        ? `仍在启用：${stillOn.join("、")}。它们与镜语的大纲/导图/无限画布视图重叠，建议停用（不会自动改你的插件开关）。`
        : "未检测到 Nestboard / gogoga 旧插件启用，视图与命令无冲突。",
    )

    containerEl.createEl("h3", { text: "剧本 Markdown 快速参考" })

    const ref = containerEl.createDiv()
    ref.className = "setting-item-description"
    ref.style.fontFamily = "monospace"
    ref.style.fontSize = "12px"
    ref.style.lineHeight = "1.8"
    ref.innerHTML = `
      <strong>五类 Modevol 语义标签：</strong><br>
      <code style="color:#2F6FAF">#d</code> 描述 &nbsp;
      <code style="color:#C0504D">#e</code> 例子 &nbsp;
      <code style="color:#5572F1">#v</code> 验证 &nbsp;
      <code style="color:#9C7A00">#t</code> 迁移 &nbsp;
      <code style="color:#7F7F7F">#c</code> 自定义说明<br><br>
      <strong>六类剧本段落：</strong><br>
      <code style="color:#3A7D44">#s</code> 场景 &nbsp;
      <code style="color:#6B5B95">#a</code> 动作 &nbsp;
      <code style="color:#A05A2C">#r</code> 角色 &nbsp;
      <code style="color:#2F6FAF">#l</code> 对白 &nbsp;
      <code style="color:#7F7F7F">#p</code> 括注 &nbsp;
      <code style="color:#A33F62">#x</code> 转场
    `
  }
}

// ==========================================================================
// Modal：新建剧本项目
// ==========================================================================
class NewScriptModal extends Modal {
  plugin: LenscriptPlugin
  editor: Editor
  inputEl!: HTMLInputElement

  constructor(app: App, plugin: LenscriptPlugin, editor: Editor) {
    super(app)
    this.plugin = plugin
    this.editor = editor
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.createEl("h2", { text: "新建剧本项目" })

    contentEl.createEl("p", {
      text: "输入项目名称，将生成包含场景、角色、对白脚手架的剧本模板。",
      cls: "setting-item-description",
    })

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "例如：夜班便利店",
      cls: "prompt-input",
    })
    this.inputEl.style.width = "100%"

    const btnRow = contentEl.createDiv()
    btnRow.style.marginTop = "16px"
    btnRow.style.display = "flex"
    btnRow.style.gap = "8px"
    btnRow.style.justifyContent = "flex-end"

    const cancelBtn = btnRow.createEl("button", { text: "取消" })
    cancelBtn.onclick = () => this.close()

    const okBtn = btnRow.createEl("button", {
      text: "生成",
      cls: "mod-cta",
    })
    okBtn.onclick = () => this.generate()

    setTimeout(() => this.inputEl.focus(), 50)
  }

  generate(): void {
    const title = this.inputEl.value.trim() || "未命名项目"
    const scaffold = buildScriptScaffold(title)
    this.editor.replaceSelection(scaffold)
    new Notice(`已生成剧本脚手架：${title}`)
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

// ==========================================================================
// Modal：模板选择器
// ==========================================================================
class TemplatePickerModal extends Modal {
  plugin: LenscriptPlugin
  editor: Editor
  private query = ""

  constructor(app: App, plugin: LenscriptPlugin, editor: Editor) {
    super(app)
    this.plugin = plugin
    this.editor = editor
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()

    contentEl.createEl("h2", { text: "剧本模板" })

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "搜索模板…",
      cls: "prompt-input",
    })
    input.style.width = "100%"
    input.style.marginBottom = "12px"

    const list = contentEl.createDiv()

    const render = () => {
      list.empty()
      const q = input.value.toLowerCase()
      const filtered = scriptTemplates.filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          (t.hint || "").toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      )
      if (filtered.length === 0) {
        list.createEl("p", {
          text: "没有匹配的模板",
          cls: "setting-item-description",
        })
      } else {
        for (const t of filtered) {
          const item = list.createDiv({ cls: "ls-outline-node" })
          item.style.padding = "6px 10px"
          item.style.cursor = "pointer"

          const badge = item.createSpan({ cls: "ls-outline-marker" })
          const catColors: Record<string, string> = {
            structure: "#2F6FAF",
            modevol: "#C0504D",
            script: "#3A7D44",
            prompt: "#6B5B95",
            actor: "#A05A2C",
            scene: "#9C7A00",
          }
          badge.style.background = catColors[t.category] || "#888"
          badge.textContent = t.category
          badge.style.fontSize = "9px"

          const textWrap = item.createDiv()
          textWrap.style.flex = "1"
          textWrap.style.marginLeft = "8px"

          textWrap.createDiv({ text: t.title, cls: "ls-outline-text" })
          if (t.hint) {
            textWrap.createDiv({
              text: t.hint,
              cls: "ls-outline-text",
            }).style.color = "var(--text-muted)"
            ;(textWrap.lastElementChild as HTMLElement).style.fontSize = "11px"
          }

          item.addEventListener("click", () => {
            this.editor.replaceSelection(t.content)
            new Notice(`已插入：${t.title}`)
            this.close()
          })
        }
      }
    }

    input.addEventListener("input", render)
    render()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

// ==========================================================================
// Modal：添加自定义标签
// ==========================================================================
class CustomTagModal extends Modal {
  private plugin: LenscriptPlugin
  private marker = "#o"
  private label = "观点"
  private color = "#2F6FAF"

  constructor(app: App, plugin: LenscriptPlugin) {
    super(app)
    this.plugin = plugin
  }

  onOpen(): void {
    this.titleEl.setText("添加自定义标签")
    const desc = this.contentEl.createDiv({ cls: "setting-item-description" })
    desc.setText("标签写在段首，格式如 #o 观点。标签符号后必须有空格。")

    new Setting(this.contentEl)
      .setName("标签符号")
      .setDesc("以 # 开头，例如 #o")
      .addText((text) =>
        text
          .setPlaceholder("#o")
          .setValue(this.marker)
          .onChange((value) => {
            this.marker = value.trim()
          }),
      )

    new Setting(this.contentEl)
      .setName("显示文字")
      .setDesc("编辑器里徽章显示的文字")
      .addText((text) =>
        text
          .setPlaceholder("观点")
          .setValue(this.label)
          .onChange((value) => {
            this.label = value
          }),
      )

    new Setting(this.contentEl)
      .setName("颜色")
      .addColorPicker((picker) =>
        picker.setValue(this.color).onChange((value) => {
          this.color = value
        }),
      )

    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("添加")
        .setCta()
        .onClick(async () => {
          const marker = normalizeMarker(this.marker)
          const error = validateCustomMarker(marker, this.plugin.settings.tags)
          if (error) {
            new Notice(error)
            return
          }
          this.plugin.settings.tags.custom.push({
            marker,
            label: this.label.trim() || marker,
            color: this.color,
            enabled: true,
          })
          await this.plugin.saveSettings()
          this.plugin.applyTagSettings()
          this.close()
        }),
    )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
