/**
 * OMM 轻量宿主适配器 — 在 lenscript 内托管 outline-mindmap 的 MindmapView
 *
 * 实现 MindmapHost 接口的最小必要集合：
 *   - settings/styles/preferences/fileHistory 都用 OMM 默认值
 *   - saveSettings / openAsNote / openSearchResult 做最小实现
 *   - reloadMindmaps 由外部传入回调
 */

import type { App, TFile, WorkspaceLeaf } from "obsidian"
import { FileHistory } from "./doc/FileHistory"
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type MindmapHost,
  type MindmapSettings,
} from "./settings/SettingsTab"
import { StyleStore, DEFAULT_STYLE } from "./settings/StyleStore"
import { ViewPreferences } from "./settings/ViewPreferences"
import type { NoteMode } from "./settings/OpenAsStore"
import type { SearchState } from "./view/search"

export class OmmHost implements MindmapHost {
  readonly fileHistory = new FileHistory<TFile>()
  settings: MindmapSettings = { ...DEFAULT_SETTINGS, styles: defaultStyleData(), openAs: {}, views: {} }
  styles: StyleStore
  preferences: ViewPreferences
  reloadMindmaps: () => void = () => {}
  /** 阅读 / 编辑模式（由镜语主插件持久化）。 */
  mindmapViewMode: 'edit' | 'read' = 'edit'
  /** 所有开着的导图在模式变化时一起刷新。 */
  private readonly modeListeners = new Set<(mode: 'edit' | 'read') => void>()
  /** 右键菜单改动后写回宿主插件（镜语把导图设置与自己的设置存在同一份 data.json）。 */
  private readonly persistMenus?: () => void

  constructor(
    private readonly app: App,
    options: {
      styles?: ReturnType<typeof defaultStyleData>
      persistStyles?: () => void
      persistMenus?: () => void
    } = {},
  ) {
    const styles = options.styles ?? defaultStyleData()
    this.settings = { ...DEFAULT_SETTINGS, styles, openAs: {}, views: {} }
    this.styles = new StyleStore(styles, options.persistStyles ?? (() => {}))
    this.preferences = new ViewPreferences(this.settings.views, () => {})
    this.persistMenus = options.persistMenus
  }

  getMindmapViewMode(): 'edit' | 'read' {
    return this.mindmapViewMode
  }

  setMindmapViewMode(mode: 'edit' | 'read'): void {
    if (this.mindmapViewMode === mode) return
    this.mindmapViewMode = mode
    for (const listener of this.modeListeners) listener(mode)
  }

  /** 订阅模式变化，返回取消订阅函数。 */
  onMindmapViewModeChange(listener: (mode: 'edit' | 'read') => void): () => void {
    this.modeListeners.add(listener)
    return () => this.modeListeners.delete(listener)
  }

  async saveSettings(): Promise<void> {
    // lenscript 托管：不写 OMM 独立 data.json，样式/偏好保持内存默认；
    // 右键菜单需要跨重启保留，交给宿主的 persistMenus 写进同一份 data.json。
    this.persistMenus?.()
  }

  async openAsNote(
    leaf: WorkspaceLeaf,
    file: TFile,
    _mode?: NoteMode,
  ): Promise<void> {
    // 就地换回 Markdown（lenscript 不需要「记住打开方式」的完整回放）
    this.fileHistory.clear(file)
    await leaf.setViewState({ type: "markdown", active: true, state: { file: file.path } })
  }

  async openSearchResult(
    leaf: WorkspaceLeaf,
    file: TFile,
    state: SearchState,
    _mode?: NoteMode,
  ): Promise<void> {
    this.fileHistory.clear(file)
    await (leaf as any).setViewState({
      type: "markdown",
      active: true,
      state: { file: file.path },
    }, state)
  }
}

/** 与 DEFAULT_SETTINGS.styles 等价的最小 StyleData */
function defaultStyleData() {
  return {
    defaults: { ...DEFAULT_STYLE },
    perFile: {} as Record<string, typeof DEFAULT_STYLE>,
  }
}

export { normalizeSettings }
