/**
 * 插件设置：四个开关（M8）。样式本身在 StyleStore / StyleModal 里。
 *
 * 【所有配置存在插件自身的 data.json，绝不写进笔记】（第 1 章红线）。
 */

import { PluginSettingTab, Setting, type App, type Plugin, type TFile, type WorkspaceLeaf } from 'obsidian'
import { t, type MsgKey } from '../i18n'
import type { FileHistory } from '../doc/FileHistory'
import type { SearchState } from '../view/search'
import { normalizeOpenAsData, type NoteMode, type OpenAsData } from './OpenAsStore'
import { normalizeViewPreferences, type ViewPreferenceData, type ViewPreferences } from './ViewPreferences'
import { defaultStyleData, normalizeStyleData, type StyleData, type StyleStore } from './StyleStore'
import {
  DEFAULT_CANVAS_MENU,
  DEFAULT_NODE_MENU,
  CANVAS_MENU_ACTIONS,
  CANVAS_MENU_META,
  NODE_MENU_ACTIONS,
  NODE_MENU_META,
  normalizeCanvasMenu,
  normalizeNodeMenu,
  type CanvasMenuAction,
  type NodeMenuAction,
} from './contextMenu'

export interface MindmapSettings {
  /** 单击节点是否跳转到笔记对应位置。关掉之后单击只选中。 */
  clickToJump: boolean
  /** 固定显示一篇笔记：开启后导图不再跟着活动笔记切换（M7。键名保持 lockFile，不迁移旧配置）。 */
  lockFile: boolean
  mapMode: 'follow' | 'fixed' | 'independent'
  /** 默认启用短过渡；大图与系统减少动态效果时使用即时布局。 */
  gracefulAnimation: boolean
  /** 严格换行：新增 / 移动节点时，相邻标题之间补足 3 个空行（附录 A.6）。 */
  strictLineBreak: boolean
  /** 把列表项显示为导图节点。关掉后导图只画标题，列表行只是最近标题的正文。 */
  orderedListNodes: boolean
  deepListMarker: '-' | '1.'
  listNodes: boolean
  /**
   * 拖拽一个节点落到【另一个节点身上】时的默认动作。
   * `'ask'` 每次弹菜单；其余三种直接执行、不再询问。
   */
  dropAction: 'ask' | 'child' | 'mergeNote' | 'mergeText'
  /** 记住每篇笔记的打开方式：用「打开为导图」转换过的笔记，下次打开直接是导图（v1.3.2）。 */
  rememberOpenAs: boolean
  /**
   * 节点右键菜单的按钮（有序）。空数组表示右键节点不弹菜单。
   * 移动端长按节点同样走这份清单。
   */
  nodeMenu: NodeMenuAction[]
  /**
   * 空白处右键 / 长按的按钮（有序）：工具条与设置里常用的那些。
   * 空数组表示右键空白不弹菜单。
   */
  canvasMenu: CanvasMenuAction[]
  /** 全局样式 + 单篇样式。运行时由 StyleStore 就地读写这一份对象。 */
  styles: StyleData
  /** 要以导图打开的笔记。运行时由 OpenAsStore 就地读写这一份对象。 */
  openAs: OpenAsData
  views: ViewPreferenceData
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  clickToJump: true,
  lockFile: false,
  mapMode: 'fixed',
  gracefulAnimation: true,
  strictLineBreak: false,
  // 列表项（含 - [ ] 待办、1. 编号）默认就是节点，和上游导图一致：
  // 它们是分支层级，而不是标题下面的「正文」。
  listNodes: true,
  orderedListNodes: true,
  deepListMarker: '-',
  // 拖到另一个节点身上默认「成为它最底部的分支」，不再每次弹菜单；
  // 想合并或每次询问可以在设置里改。
  dropAction: 'child',
  rememberOpenAs: true,
  nodeMenu: [...DEFAULT_NODE_MENU],
  canvasMenu: [...DEFAULT_CANVAS_MENU],
  styles: defaultStyleData(),
  openAs: {},
  views: {},
}

/** data.json 里读到的东西 → 一份合法设置。缺字段、类型不对、超范围的一律收拢。 */
export function normalizeSettings(raw: unknown): MindmapSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  const bool = (key: keyof MindmapSettings, fallback: boolean): boolean =>
    typeof o[key] === 'boolean' ? o[key] : fallback
  return {
    clickToJump: bool('clickToJump', DEFAULT_SETTINGS.clickToJump),
    mapMode: o.mapMode === 'follow' || o.mapMode === 'fixed' || o.mapMode === 'independent'
      ? o.mapMode : o.independentMaps === true ? 'independent' : 'fixed',
    lockFile: bool('lockFile', DEFAULT_SETTINGS.lockFile),
    gracefulAnimation: bool('gracefulAnimation', DEFAULT_SETTINGS.gracefulAnimation),
    strictLineBreak: bool('strictLineBreak', DEFAULT_SETTINGS.strictLineBreak),
    deepListMarker: o.deepListMarker === '1.' ? '1.' : '-',
    dropAction: o.dropAction === 'child' || o.dropAction === 'mergeNote' || o.dropAction === 'mergeText'
      ? o.dropAction : 'ask',
    orderedListNodes: bool('orderedListNodes', DEFAULT_SETTINGS.orderedListNodes),
    listNodes: bool('listNodes', DEFAULT_SETTINGS.listNodes),
    rememberOpenAs: bool('rememberOpenAs', DEFAULT_SETTINGS.rememberOpenAs),
    nodeMenu: normalizeNodeMenu(o['nodeMenu']),
    canvasMenu: normalizeCanvasMenu(o['canvasMenu']),
    styles: normalizeStyleData(o['styles']),
    openAs: normalizeOpenAsData(o['openAs']),
    views: normalizeViewPreferences(o['views']),
  }
}

/**
 * 视图需要的插件能力。
 *
 * 视图不直接依赖插件类——那会让 main.ts 与 view/ 互相 import。
 */
export interface MindmapHost {
  readonly fileHistory: FileHistory<TFile>
  readonly settings: MindmapSettings
  readonly styles: StyleStore
  readonly preferences: ViewPreferences
  saveSettings(): Promise<void>
  /** 解析类设置变了（如「把列表项显示为节点」）：让所有导图按新规则重新解析当前笔记。 */
  reloadMindmaps(): void
  refreshMapMode?(): void
  /**
   * 导图的阅读 / 编辑模式。由外层插件持久化（OMM 自己的 saveSettings 在镜语里是空实现）。
   * 不实现时导图退回「永远可编辑」。
   */
  getMindmapViewMode?(): 'edit' | 'read'
  setMindmapViewMode?(mode: 'edit' | 'read'): void
  /** 导图这一侧的「打开为笔记」：同一个叶子就地变回 Markdown，并忘掉「以导图打开」的记忆。 */
  openAsNote(leaf: WorkspaceLeaf, file: TFile, mode?: NoteMode): Promise<void>
  openSearchResult(leaf: WorkspaceLeaf, file: TFile, state: SearchState, mode?: NoteMode): Promise<void>
}

export class MindmapSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: MindmapHost,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl).setName(t('settings.openMode')).setHeading()
    new Setting(containerEl).setName(t('settings.mainArea')).setDesc(t('settings.mainAreaDesc')).addDropdown(dropdown => dropdown
      .addOption('follow', t('settings.follow'))
      .addOption('fixed', t('settings.fixed'))
      .addOption('independent', t('settings.independentMaps'))
      .setValue(this.host.settings.mapMode)
      .onChange(async mode => {
        if (mode !== 'follow' && mode !== 'fixed' && mode !== 'independent') return
        this.host.settings.mapMode = mode
        this.host.refreshMapMode?.()
        await this.host.saveSettings()
      }))
    new Setting(containerEl).setName(t('settings.lockFile')).setDesc(t('settings.lockFileDesc'))
      .addDropdown(dropdown => dropdown.addOption('follow', t('settings.follow')).addOption('fixed', t('settings.fixed'))
        .setValue(this.host.settings.lockFile ? 'fixed' : 'follow').onChange(async value => {
          this.host.settings.lockFile = value === 'fixed'
          this.host.refreshMapMode?.()
          await this.host.saveSettings()
        }))
    this.toggle('settings.rememberOpenAs', 'settings.rememberOpenAsDesc', 'rememberOpenAs')
    new Setting(containerEl).setName(t('settings.nodes')).setHeading()
    this.toggle('settings.strictLineBreak', 'settings.strictLineBreakDesc', 'strictLineBreak')
    // 这一项影响解析结果：切完立即让已有的导图按新规则重画，不用关开一次视图
    this.toggle('settings.listNodes', 'settings.listNodesDesc', 'listNodes', () =>
      this.host.reloadMindmaps(),
    )
    this.toggle('settings.orderedListNodes', 'settings.orderedListNodesDesc', 'orderedListNodes', () => this.host.reloadMindmaps())
    new Setting(containerEl).setName(t('settings.deepFormat')).setDesc(t('settings.deepFormatDesc'))
      .addDropdown(dropdown => dropdown.addOption('-', t('settings.unordered')).addOption('1.', t('settings.ordered'))
        .setValue(this.host.settings.deepListMarker).onChange(async value => {
          this.host.settings.deepListMarker = value === '1.' ? '1.' : '-'
          await this.host.saveSettings()
        }))
    new Setting(containerEl).setName(t('settings.interaction')).setHeading()
    this.toggle('settings.clickToJump', 'settings.clickToJumpDesc', 'clickToJump')
    this.toggle('settings.gracefulAnimation', 'settings.gracefulAnimationDesc', 'gracefulAnimation')
    new Setting(containerEl).setName(t('settings.dropAction')).setDesc(t('settings.dropActionDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('ask', t('drop.ask'))
        .addOption('child', t('drop.child'))
        .addOption('mergeNote', t('drop.mergeNote'))
        .addOption('mergeText', t('drop.mergeText'))
        .setValue(this.host.settings.dropAction).onChange(async value => {
          this.host.settings.dropAction = value === 'child' || value === 'mergeNote' || value === 'mergeText'
            ? value : 'ask'
          await this.host.saveSettings()
        }))

    new Setting(containerEl).setName(t('settings.contextMenu')).setHeading()
    renderContextMenuSettings(containerEl, {
      nodeMenu: () => this.host.settings.nodeMenu,
      setNodeMenu: (next) => { this.host.settings.nodeMenu = next },
      canvasMenu: () => this.host.settings.canvasMenu,
      setCanvasMenu: (next) => { this.host.settings.canvasMenu = next },
      save: () => this.host.saveSettings(),
      rerender: () => this.display(),
    })
  }

  /** 几个开关长得一模一样，写成一个方法免得同一段代码抄五遍。 */
  private toggle(name: MsgKey, desc: MsgKey, key: BooleanSettingKey, afterChange?: () => void): void {
    new Setting(this.containerEl)
      .setName(t(name))
      .setDesc(t(desc))
      .addToggle((t) =>
        t.setValue(this.host.settings[key]).onChange(async (value) => {
          this.host.settings[key] = value
          afterChange?.()
          await this.host.saveSettings()
        }),
      )
  }
}

type BooleanSettingKey = {
  [K in keyof MindmapSettings]: MindmapSettings[K] extends boolean ? K : never
}[keyof MindmapSettings]

// ── 右键菜单编排（独立导图插件与镜语主插件共用）─────────────────

export interface ContextMenuSettingsHooks {
  nodeMenu: () => readonly NodeMenuAction[]
  setNodeMenu: (next: NodeMenuAction[]) => void
  canvasMenu: () => readonly CanvasMenuAction[]
  setCanvasMenu: (next: CanvasMenuAction[]) => void
  save: () => Promise<void>
  rerender: () => void
}

/**
 * 在任意设置页里渲染「右键菜单」整块：说明 + 节点菜单 + 空白处菜单。
 *
 * 单独抽出来是因为镜语主插件用的是自己的设置页（LenscriptSettingTab），
 * 不注册 OMM 的 MindmapSettingTab；两边调同一个函数，界面与行为不会漂移。
 */
export function renderContextMenuSettings(containerEl: HTMLElement, hooks: ContextMenuSettingsHooks): void {
  containerEl.createEl('p', {
    cls: 'setting-item-description',
    text: t('settings.contextMenuDesc'),
  })
  containerEl.createEl('p', { cls: 'om-menu-section', text: t('settings.menuSectionNode') })
  renderMenuList(containerEl, {
    get: hooks.nodeMenu,
    set: (next) => hooks.setNodeMenu(next as NodeMenuAction[]),
    catalog: NODE_MENU_ACTIONS,
    meta: NODE_MENU_META,
    save: hooks.save,
    rerender: hooks.rerender,
  })
  containerEl.createEl('p', { cls: 'om-menu-section', text: t('settings.menuSectionCanvas') })
  renderMenuList(containerEl, {
    get: hooks.canvasMenu,
    set: (next) => hooks.setCanvasMenu(next as CanvasMenuAction[]),
    catalog: CANVAS_MENU_ACTIONS,
    meta: CANVAS_MENU_META,
    save: hooks.save,
    rerender: hooks.rerender,
  })
}

/** 一份菜单的按钮编排：已选中的按顺序排好，每行可上移 / 下移 / 移除；下方可再添加。 */
function renderMenuList(containerEl: HTMLElement, config: {
  get: () => readonly string[]
  set: (next: string[]) => void
  catalog: readonly string[]
  meta: Record<string, { label: MsgKey }>
  save: () => Promise<void>
  rerender: () => void
}): void {
  const list = [...config.get()]
  const wrap = containerEl.createDiv({ cls: 'om-menu-builder' })

  list.forEach((action, index) => {
    const row = new Setting(wrap).setName(t(config.meta[action]!.label))
    row.settingEl.addClass('om-menu-row')
    row.addExtraButton(button => button
      .setIcon('arrow-up')
      .setTooltip(t('settings.menuMoveUp'))
      .setDisabled(index === 0)
      .onClick(async () => {
        if (index === 0) return
        const next = [...list]
        ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
        config.set(next)
        await config.save()
        config.rerender()
      }))
    row.addExtraButton(button => button
      .setIcon('arrow-down')
      .setTooltip(t('settings.menuMoveDown'))
      .setDisabled(index === list.length - 1)
      .onClick(async () => {
        if (index >= list.length - 1) return
        const next = [...list]
        ;[next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
        config.set(next)
        await config.save()
        config.rerender()
      }))
    row.addExtraButton(button => button
      .setIcon('x')
      .setTooltip(t('settings.menuRemove'))
      .onClick(async () => {
        config.set(list.filter((_, i) => i !== index))
        await config.save()
        config.rerender()
      }))
  })

  if (list.length === 0) {
    wrap.createEl('p', { cls: 'om-menu-empty', text: t('settings.contextMenuEmpty') })
  }

  const remaining = config.catalog.filter(action => !list.includes(action))
  if (remaining.length === 0) return
  let picked: string = remaining[0]!
  new Setting(wrap)
    .setName(t('settings.contextMenuAdd'))
    .addDropdown(dropdown => {
      for (const action of remaining) dropdown.addOption(action, t(config.meta[action]!.label))
      dropdown.setValue(picked).onChange(value => {
        if (config.catalog.includes(value)) picked = value
      })
    })
    .addButton(button => button
      .setButtonText('+')
      .setTooltip(t('settings.contextMenuAdd'))
      .onClick(async () => {
        config.set([...list, picked])
        await config.save()
        config.rerender()
      }))
}
