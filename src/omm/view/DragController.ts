/**
 * 拖拽重排（M6）。
 *
 * 职责边界：本文件只负责【把指针的位置翻译成一个落点】，以及落点的视觉反馈。
 * 真正的结构变更走的还是 core/tree.ts 的 `moveSubtree` —— 跨 6/7 层的
 * 标题 ↔ 列表转换、正文跟随、分隔空行处理，全在那边（附录 A.7.4、A.8），
 * 这里一行都不重复。
 *
 * 落点判定与合法性判定是【纯函数】（hitTest / resolveDrop / isSamePosition），
 * 拆出来是为了能脱离 DOM 单测——「不能拖到自己的子树里」这类规则不该靠手工点来验。
 *
 * 监听器共 4 个，全挂在节点图层上（事件委托，与节点数量无关）。
 */

import type { MindNode, MindTree } from '../core/types'
import type { Box, LayoutResult } from '../layout/types'
import type { Canvas } from './Canvas'

/** 落在目标节点的哪个区域。'into' = 成为它的最后一个子节点；'independent' = 成为独立节点。 */
export type DropZone = 'before' | 'after' | 'into' | 'independent'

/** `id === null` 表示落在画布空白处 → 新的自由根节点。 */
export interface DropTarget {
  id: string | null
  zone: DropZone
}

/** 落点解析结果，可直接喂给 `moveSubtree`。 */
export interface DropResult {
  parentId: string | null
  index: number
}

/** 节点上下边缘各 25% 判为「插到前 / 后」，中间 50% 判为「成为子节点」。 */
const EDGE_RATIO = 0.25
/** 指针离最近节点超过这个距离（布局坐标）就算落在空白处。留一点容差，免得落在兄弟间隙里就变成建根。 */
const HIT_TOLERANCE = 12
/** 指针移动超过这个距离才算拖拽，否则仍是一次单击。 */
const DRAG_THRESHOLD = 4

// ── 纯函数：落点判定 ─────────────────────────────────────────────

/** 点到矩形的距离；点在矩形内为 0。 */
function rectDistance(box: Box, x: number, y: number): number {
  const dx = Math.max(box.x - x, 0, x - (box.x + box.w))
  const dy = Math.max(box.y - y, 0, y - (box.y + box.h))
  return Math.hypot(dx, dy)
}

function zoneOf(box: Box, x: number, y: number, orientation: 'h' | 'v'): DropZone {
  // 横向布局：兄弟在竖直方向排队 → 按 y 分上中下；
  // 向下组织图：兄弟在水平方向排队 → 按 x 分左中右。
  const r = orientation === 'v'
    ? (box.w > 0 ? (x - box.x) / box.w : 0.5)
    : (box.h > 0 ? (y - box.y) / box.h : 0.5)
  if (r < EDGE_RATIO) return 'before'
  if (r > 1 - EDGE_RATIO) return 'after'
  return 'into'
}

/**
 * 布局坐标 → 落点。
 *
 * @param order 可见节点 id（文档序）。任意两个节点的矩形不重叠（M3 的验收保证过），
 *   所以一旦命中就可以直接返回，不必比完所有节点。
 */
export function hitTest(
  order: readonly string[],
  boxes: LayoutResult,
  x: number,
  y: number,
  orientation: 'h' | 'v' = 'h',
  ignore?: ReadonlySet<string>,
): DropTarget {
  let bestId: string | null = null
  let bestBox: Box | null = null
  let bestDist = Infinity

  for (const id of order) {
    if (ignore?.has(id)) continue
    const box = boxes.get(id)
    if (!box) continue
    const d = rectDistance(box, x, y)
    if (d < bestDist) {
      bestDist = d
      bestId = id
      bestBox = box
    }
    if (d === 0) break
  }

  if (bestId === null || bestBox === null || bestDist > HIT_TOLERANCE) {
    return { id: null, zone: 'into' }
  }
  return { id: bestId, zone: zoneOf(bestBox, x, y, orientation) }
}

function isDescendantOf(node: MindNode, maybeAncestor: MindNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p === maybeAncestor) return true
  }
  return false
}

/**
 * 落点 → `moveSubtree` 的参数。非法落点返回 null。
 *
 * 非法的只有一类：目标是被拖节点自身或它的后代（附录 A.7.4 第 1 步）。
 * 这里返回 null 而不是抛错，是因为【拖拽过程中就要把这种落点标成不可选】——
 * 等松手了才报错，用户已经白拖了一趟。
 *
 * `index` 一律是【剔除被拖节点之后】的兄弟数组下标，与 `moveSubtree` 的约定一致。
 */
export function resolveDrop(tree: MindTree, dragId: string, target: DropTarget): DropResult | null {
  const node = tree.byId.get(dragId)
  if (!node) return null

  // 画布空白 → 成为最后一个自由根
  if (target.id === null) {
    return { parentId: null, index: tree.root.children.filter((c) => c !== node).length }
  }

  const t = tree.byId.get(target.id)
  if (!t || t === node || isDescendantOf(t, node)) return null

  if (target.zone === 'into') {
    return { parentId: t.id, index: t.children.filter((c) => c !== node).length }
  }

  const parent = t.parent
  if (!parent) return null
  const siblings = parent.children.filter((c) => c !== node)
  const i = siblings.indexOf(t)
  if (i < 0) return null
  return {
    parentId: parent.depth > 0 ? parent.id : null,
    index: target.zone === 'before' ? i : i + 1,
  }
}

/**
 * 落点与节点当前位置完全相同 → 这次拖拽什么都不该做。
 *
 * `moveSubtree` 对原地移动是幂等的（有测试），但仍会产生一次写入和一次可撤销的变更。
 * 手一抖把节点拖起来又放回原处，不该在笔记的撤销栈里留下一格。
 */
export function isSamePosition(tree: MindTree, dragId: string, result: DropResult): boolean {
  const node = tree.byId.get(dragId)
  const parent = node?.parent
  if (!node || !parent) return false
  if ((parent.depth > 0 ? parent.id : null) !== result.parentId) return false
  // result.index 是【剔除本节点之后】的下标：把它从 children 里抽掉再插回原下标，就是原地。
  return result.index === parent.children.indexOf(node)
}

// ── 控制器 ──────────────────────────────────────────────────────

export interface DragHooks {
  canvas: Canvas
  tree: () => MindTree | null
  boxes: () => LayoutResult
  /** 可见节点 id，文档序。 */
  order: () => readonly string[]
  /** 编辑态下不允许拖拽。 */
  enabled: () => boolean
  /** 松手且落点合法时调用。`target` 让调用方判断是不是「落到某个节点身上」。 */
  onDrop: (dragId: string, result: DropResult, target: DropTarget, x: number, y: number) => void
  /** 拖拽视觉：被拖走的整棵子树（置灰）、当前「成为其子节点」的目标（高亮）。 */
  onVisual: (dragging: ReadonlySet<string>, into: string | null) => void
  /**
   * 落点语义（成为子节点 / 合并）交给 onDrop 判断。
   *
   * 这里只负责把指针翻译成落点。
   * 免得把业务规则（叶子、层级）塞进通用的落点判定里。
   */


  /** 当前布局方向：向下组织图按左右分区判定 before/after。 */
  orientation?: () => 'h' | 'v'
  /**
   * 画布底部的「独立」投放区矩形（视口坐标）。指针落在里面时，落点变成
   * 「把这个节点从父节点上摘下来，成为独立节点」。
   */
  independentRect?: () => DOMRect | null
  /** 指针是否悬在「独立」投放区上——视图用它切换高亮。 */
  onIndependent?: (active: boolean) => void
  /** 合并手势松手：交给调用方弹选择菜单，不再执行普通移动。 */

  /**
   * 这个节点能不能「自由拖动」：带 `%%float%%` 的独立节点没有结构落点，
   * 拖它就是在画布上挪位置，松手时把新位置写回 `%%float%%`。
   * 不提供 / 返回 false 的节点仍走结构重排（M6 的老行为）。
   */
  freeDrag?: (id: string) => boolean
  /** 自由拖动开始。视图在这里记下起始几何，供后续帧平移。 */
  onFreeStart?: (id: string) => void
  /** 自由拖动中：`dx` / `dy` 是相对起点的布局坐标位移。 */
  onFreeMove?: (id: string, dx: number, dy: number) => void
  /** 自由拖动松手：落点已确定，调用方写回 `%%float%%`。 */
  onFreeDrop?: (id: string, dx: number, dy: number) => void
  /** 自由拖动被取消（Esc / 手势中断）：把预览位置还原。 */
  onFreeCancel?: () => void
  /** 自由拖动最终变成了结构落点：清掉预览快照，不写 %%float%%。 */
  onFreeRelease?: () => void
}

export class DragController {
  private readonly indicator: HTMLElement
  private readonly empty: ReadonlySet<string> = new Set()

  private pointerId: number | null = null
  private candidate: string | null = null
  private dragId: string | null = null
  /** 自由拖动中的节点（带 %%float%% 的独立节点）；null = 普通结构拖拽。 */
  private freeId: string | null = null
  /** 自由拖动起点（布局坐标），每次拖拽只算一次。 */
  private freeStart: { x: number; y: number } | null = null
  /** 最近一帧的布局坐标位移，松手时直接复用。 */
  private freeDelta = { dx: 0, dy: 0 }
  /** 自由拖动时要排除的子树（不参与 hitTest，否则只会命中自己）。 */
  private freeSubtree: Set<string> | null = null
  /** 被拖走的整棵子树。开始时算一次，拖拽过程中不会变。 */
  private draggingIds: ReadonlySet<string> = new Set()
  private startX = 0
  private startY = 0
  /** 视口矩形在一次拖拽内不会变，开始时读一次就够——绝不逐节点、逐帧读。 */
  private rect: DOMRect | null = null
  private target: DropTarget = { id: null, zone: 'into' }
  private result: DropResult | null = null
  /** 松手位置，用来定位合并选择菜单。 */
  private lastX = 0
  private lastY = 0
  /** 刚刚拖完，紧随其后的那次 click 不该再触发选中与跳转。 */
  private dragged = false
  private frame: number | null = null
  private pending: { x: number; y: number } | null = null

  constructor(
    private readonly layer: HTMLElement,
    private readonly hooks: DragHooks,
  ) {
    this.indicator = hooks.canvas.content.createDiv({ cls: 'om-drop is-hidden' })
    layer.addEventListener('pointerdown', this.onPointerDown)
    layer.addEventListener('pointermove', this.onPointerMove)
    layer.addEventListener('pointerup', this.onPointerUp)
    layer.addEventListener('pointercancel', this.onPointerCancel)
  }

  destroy(): void {
    this.reset()
    this.layer.removeEventListener('pointerdown', this.onPointerDown)
    this.layer.removeEventListener('pointermove', this.onPointerMove)
    this.layer.removeEventListener('pointerup', this.onPointerUp)
    this.layer.removeEventListener('pointercancel', this.onPointerCancel)
    this.indicator.remove()
  }

  get active(): boolean {
    return this.dragId !== null
  }

  /** Esc / 视图关闭：放弃这次拖拽，什么都不写。 */
  cancel(): void {
    // A second finger or a lock can arrive before the drag threshold is crossed.
    const freeId = this.freeId
    this.dragged = false
    this.reset()
    if (freeId) this.hooks.onFreeCancel?.()
  }

  /**
   * 「刚才那下是拖拽吗」——供 click 处理器询问一次。
   * 拖完松手浏览器还会补一个 click，不吃掉它就会顺手跳转到笔记里去。
   */
  consumeClick(): boolean {
    const was = this.dragged
    this.dragged = false
    return was
  }

  // ── 事件 ────────────────────────────────────────────────────

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.pointerId !== null || !this.hooks.enabled()) return
    const el = (e.target as HTMLElement).closest<HTMLElement>('.om-node')
    // 折叠按钮、关联线手柄、备注卡片都有自己的手势，不能一按就被当成要拖动节点
    if (!el || (e.target as HTMLElement).closest('.om-toggle, .om-body-toggle, .om-rel-handle, .om-note')) return
    const id = el.dataset['nodeId']
    if (!id) return

    this.pointerId = e.pointerId
    this.candidate = id
    this.startX = e.clientX
    this.startY = e.clientY
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return
    if (!this.dragId) {
      const moved = Math.abs(e.clientX - this.startX) + Math.abs(e.clientY - this.startY)
      if (moved < DRAG_THRESHOLD) return
      if (!this.begin()) return
    }
    // 每帧只算一次落点：pointermove 可能一秒来上百个
    this.pending = { x: e.clientX, y: e.clientY }
    if (this.frame === null) {
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null
        this.update()
      })
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return
    const dragId = this.dragId
    const result = this.result
    const target = this.target
    const { lastX, lastY } = this
    const freeId = this.freeId
    const freeDelta = this.freeDelta
    const dragging = dragId !== null
    this.reset()
    if (!dragging || !dragId) return
    this.dragged = true
    if (freeId) {
      // 落在别的节点身上 → 照常走结构落点（成为子节点 / 合并）；
      // 落在空白处 → 写回自由位置。
      if (target && target.id !== null && result) {
        this.hooks.onFreeRelease?.()
        this.hooks.onDrop(freeId, result, target, lastX, lastY)
      } else {
        this.hooks.onFreeDrop?.(freeId, freeDelta.dx, freeDelta.dy)
      }
      return
    }
    if (result) this.hooks.onDrop(dragId, result, target, lastX, lastY)
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return
    const freeId = this.freeId
    this.reset()
    if (freeId) this.hooks.onFreeCancel?.()
  }

  // ── 内部 ────────────────────────────────────────────────────

  private begin(): boolean {
    const id = this.candidate
    const tree = this.hooks.tree()
    const node = id === null ? null : tree?.byId.get(id)
    if (!id || !node) return false

    this.dragId = id
    this.rect = this.hooks.canvas.viewportRect()
    // 独立节点（%%float%%）拖的是位置，不是结构：不参与落点判定
    const free = this.hooks.freeDrag?.(id) === true
    if (free) {
      this.freeId = id
      this.freeStart = this.hooks.canvas.toContent(this.rect, this.startX, this.startY)
      this.freeDelta = { dx: 0, dy: 0 }
      this.hooks.canvas.viewport.classList.add('is-free-dragging')
      this.freeSubtree = subtreeIds(node)
      this.hooks.onFreeStart?.(id)
    }
    if (this.pointerId !== null && !this.layer.hasPointerCapture(this.pointerId)) {
      this.layer.setPointerCapture(this.pointerId)
    }
    this.hooks.canvas.viewport.classList.add('is-dragging')
    // 焦点收回导图：拖拽中按 Esc 要能取消（键盘在 MindmapView 上）
    this.hooks.canvas.focus()
    this.draggingIds = subtreeIds(node)
    // 自由拖动不是「搬走一坨」，不要把整棵子树置灰，也不要弹「独立」投放区
    this.hooks.onVisual(free ? this.empty : this.draggingIds, null)
    return true
  }

  /** 指针位置 → 落点 → 指示线。这是拖拽过程里唯一会跑的计算。 */
  private update(): void {
    const p = this.pending
    const tree = this.hooks.tree()
    const dragId = this.dragId
    if (!p || !tree || !dragId || !this.rect) return

    this.lastX = p.x
    this.lastY = p.y

    // 自由拖动：只有位置，没有落点。每帧把位移交给视图平移子树。
    if (this.freeId && this.freeStart) {
      const point = this.hooks.canvas.toContent(this.rect, p.x, p.y)
      this.freeDelta = { dx: point.x - this.freeStart.x, dy: point.y - this.freeStart.y }
      this.hooks.onFreeMove?.(this.freeId, this.freeDelta.dx, this.freeDelta.dy)

      // 自由拖动的同时判定「有没有落在别的节点上」：
      // 落上节点就临时变成结构落点，松手按合并 / 成为子节点处理。
      const hit = hitTest(
        this.hooks.order(),
        this.hooks.boxes(),
        point.x,
        point.y,
        this.hooks.orientation?.() ?? 'h',
        this.freeSubtree ?? undefined,
      )
      this.target = hit
      if (hit.id === null) {
        this.result = null
        this.indicator.addClass('is-hidden')
        const vp = this.hooks.canvas.viewport
        vp.classList.remove('is-drop-invalid', 'is-drop-root')
        this.hooks.onVisual(this.empty, null)
        return
      }
      const result = resolveDrop(tree, this.freeId, hit)
      this.result = result
      this.paint(result !== null)
      return
    }

    // 底部「独立」投放区优先：它盖在画布上，落在里面就不再按节点算
    const dock = this.hooks.independentRect?.()
    if (dock && p.x >= dock.left && p.x <= dock.right && p.y >= dock.top && p.y <= dock.bottom) {
      this.target = { id: null, zone: 'independent' }
      this.result = { parentId: null, index: 0 }
      this.paint(true)
      return
    }

    const { x, y } = this.hooks.canvas.toContent(this.rect, p.x, p.y)
    this.target = hitTest(this.hooks.order(), this.hooks.boxes(), x, y, this.hooks.orientation?.() ?? 'h')
    const result = resolveDrop(tree, dragId, this.target)
    // 原地放下不算一次移动，指示线照常给——用户看得见「放回原处」是有效操作。
    // 落到画布空白处是例外：那是「按落点自由摆放」，即使文档序没变也要执行。
    this.result = result && this.target.id !== null && isSamePosition(tree, dragId, result)
      ? null
      : result
    this.paint(result !== null)
  }

  private paint(valid: boolean): void {
    const vp = this.hooks.canvas.viewport
    const t = this.target
    const independent = t.zone === 'independent'
    this.hooks.onIndependent?.(independent)
    // 非法落点：不画指示线 + 光标变禁止符，落点在视觉上就是不可选的
    vp.classList.toggle('is-drop-invalid', !valid)
    vp.classList.toggle('is-drop-root', valid && !independent && t.id === null && !this.freeId)

    const box = valid && !independent && t.id !== null ? this.hooks.boxes().get(t.id) : undefined
    this.hooks.onVisual(this.freeId ? this.empty : this.draggingIds, box && t.zone === 'into' ? t.id : null)
    if (!box) {
      this.indicator.addClass('is-hidden')
      return
    }

    const into = t.zone === 'into'
    this.indicator.removeClass('is-hidden')
    this.indicator.classList.toggle('is-into', into)
    this.indicator.classList.remove('is-merge')
    const y = t.zone === 'after' ? box.y + box.h : box.y
    this.indicator.setCssStyles({
      transform: `translate(${box.x}px, ${into ? box.y : y}px)`,
      width: `${box.w}px`,
      height: into ? `${box.h}px` : '0px',
    })
  }

  private reset(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (this.pointerId !== null && this.layer.hasPointerCapture(this.pointerId)) {
      this.layer.releasePointerCapture(this.pointerId)
    }
    if (this.dragId) this.hooks.onVisual(this.empty, null)
    this.hooks.onIndependent?.(false)
    const vp = this.hooks.canvas.viewport
    vp.classList.remove('is-dragging', 'is-drop-invalid', 'is-drop-root', 'is-free-dragging')
    this.indicator.addClass('is-hidden')
    this.indicator.classList.remove('is-merge')
    this.pointerId = null
    this.candidate = null
    this.dragId = null
    this.freeId = null
    this.freeStart = null
    this.freeSubtree = null
    this.freeDelta = { dx: 0, dy: 0 }
    this.draggingIds = this.empty
    this.rect = null
    this.result = null
    this.pending = null
    this.target = { id: null, zone: 'into' }
  }
}

/** 节点自身 + 全部后代的 id。拖拽时整棵子树一起置灰——它们是跟着走的。 */
export function subtreeIds(node: MindNode): Set<string> {
  const out = new Set<string>()
  const walk = (n: MindNode): void => {
    out.add(n.id)
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}
