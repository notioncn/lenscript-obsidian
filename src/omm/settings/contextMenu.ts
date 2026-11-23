/**
 * 节点右键菜单的按钮目录。
 *
 * 设置页与视图共用同一份清单：设置里勾选 / 排序，视图按这个顺序建菜单。
 * 这里只有「id + 文案 + 图标 + 分组」，真正做什么由视图按 id 分发——
 * 免得把「删除节点」这种带业务的动作塞进设置层。
 */

import type { MsgKey } from '../i18n'

export const NODE_MENU_ACTIONS = [
  'rename',
  'editBody',
  'addChild',
  'addSibling',
  'addOrdered',
  'addUnordered',
  'independent',
  'collapse',
  'remove',
  'summary',
  'removeSummary',
  'box',
  'removeBox',
  'callout',
  'removeCallout',
] as const

export type NodeMenuAction = (typeof NODE_MENU_ACTIONS)[number]

export interface NodeMenuMeta {
  label: MsgKey
  icon: string
  /** 菜单里的分组号：换组时插一条分隔线。 */
  group: number
}

export const NODE_MENU_META: Record<NodeMenuAction, NodeMenuMeta> = {
  rename: { label: 'menu.rename', icon: 'pencil', group: 1 },
  editBody: { label: 'menu.editBody', icon: 'align-left', group: 1 },
  addChild: { label: 'menu.addChild', icon: 'plus', group: 2 },
  addSibling: { label: 'menu.addSibling', icon: 'git-branch', group: 2 },
  addOrdered: { label: 'menu.addOrdered', icon: 'list-ordered', group: 2 },
  addUnordered: { label: 'menu.addUnordered', icon: 'list', group: 2 },
  independent: { label: 'menu.makeIndependent', icon: 'ungroup', group: 3 },
  collapse: { label: 'menu.collapse', icon: 'chevrons-down-up', group: 3 },
  remove: { label: 'menu.remove', icon: 'trash-2', group: 3 },
  summary: { label: 'anno.summaryTitle', icon: 'brackets', group: 4 },
  removeSummary: { label: 'menu.removeSummary', icon: 'trash-2', group: 4 },
  box: { label: 'anno.boxTitle', icon: 'square', group: 4 },
  removeBox: { label: 'menu.removeBox', icon: 'trash-2', group: 4 },
  callout: { label: 'anno.calloutTitle', icon: 'message-square', group: 4 },
  removeCallout: { label: 'menu.removeCallout', icon: 'trash-2', group: 4 },
}

/** 默认全部打开，顺序与原右键菜单一致。 */
export const DEFAULT_NODE_MENU: NodeMenuAction[] = [
  'editBody',
  'addChild',
  'addSibling',
  'addOrdered',
  'addUnordered',
  'rename',
  'independent',
  'collapse',
  'remove',
  'summary',
  'box',
  'callout',
  'removeSummary',
  'removeBox',
  'removeCallout',
]

// ── 空白处（画布）右键菜单 ─────────────────────────────────────

/**
 * 空白处右键/长按的按钮目录。
 *
 * 这里放的是「工具条 + 设置里常用」的那一批：画布操作、视图切换、主题与导出。
 * 与节点菜单分开维护——同一份清单既要在节点上出现又要在空白处出现，过滤逻辑会互相打架。
 */
export const CANVAS_MENU_ACTIONS = [
  'freeTopic',
  'fit',
  'zoomIn',
  'zoomOut',
  'center',
  'bodies',
  'foldLevel',
  'direction',
  'theme',
  'style',
  'search',
  'undo',
  'redo',
  'export',
  'lock',
  'recite',
  'mode',
  'settings',
] as const

export type CanvasMenuAction = (typeof CANVAS_MENU_ACTIONS)[number]

export const CANVAS_MENU_META: Record<CanvasMenuAction, NodeMenuMeta> = {
  freeTopic: { label: 'menu.addFreeTopic', icon: 'type', group: 1 },
  fit: { label: 'tool.fit', icon: 'maximize', group: 1 },
  zoomIn: { label: 'tool.zoomIn', icon: 'zoom-in', group: 1 },
  zoomOut: { label: 'tool.zoomOut', icon: 'zoom-out', group: 1 },
  center: { label: 'tool.center', icon: 'crosshair', group: 1 },
  bodies: { label: 'tool.bodies', icon: 'eye', group: 2 },
  foldLevel: { label: 'tool.foldLevel', icon: 'layers', group: 2 },
  direction: { label: 'tool.direction', icon: 'git-fork', group: 2 },
  theme: { label: 'tool.theme', icon: 'paintbrush', group: 2 },
  style: { label: 'tool.style', icon: 'palette', group: 2 },
  search: { label: 'tool.search', icon: 'search', group: 3 },
  undo: { label: 'menu.undo', icon: 'undo-2', group: 3 },
  redo: { label: 'menu.redo', icon: 'redo-2', group: 3 },
  export: { label: 'tool.export', icon: 'download', group: 3 },
  lock: { label: 'tool.lock', icon: 'lock-open', group: 3 },
  recite: { label: 'tool.recite', icon: 'glasses', group: 3 },
  mode: { label: 'tool.readMode', icon: 'book-open', group: 3 },
  settings: { label: 'menu.openSettings', icon: 'settings', group: 3 },
}

export const DEFAULT_CANVAS_MENU: CanvasMenuAction[] = [
  'freeTopic',
  'fit',
  'zoomIn',
  'zoomOut',
  'center',
  'bodies',
  'mode',
  'search',
  'undo',
  'redo',
  'theme',
  'style',
  'export',
  'settings',
]

const KNOWN_CANVAS = new Set<string>(CANVAS_MENU_ACTIONS)

/** 与 `normalizeNodeMenu` 同一套规则：缺字段回退默认，空数组是合法的。 */
export function normalizeCanvasMenu(raw: unknown): CanvasMenuAction[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CANVAS_MENU]
  const out: CanvasMenuAction[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN_CANVAS.has(value)) continue
    const action = value as CanvasMenuAction
    if (!out.includes(action)) out.push(action)
  }
  return out
}

const KNOWN = new Set<string>(NODE_MENU_ACTIONS)

/**
 * data.json → 合法的菜单列表。
 *
 * 与其它设置不同，【空数组是合法的】（用户可以把按钮全删光）；
 * 只有「字段缺失 / 不是数组」才回退到默认值。
 */
export function normalizeNodeMenu(raw: unknown): NodeMenuAction[] {
  if (!Array.isArray(raw)) return [...DEFAULT_NODE_MENU]
  const out: NodeMenuAction[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN.has(value)) continue
    const action = value as NodeMenuAction
    if (!out.includes(action)) out.push(action)
  }
  return out
}
