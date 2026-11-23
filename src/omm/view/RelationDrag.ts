/**
 * 关联线的纯鼠标绘制。
 *
 * 左键拖动节点是「搬动节点」，所以画关联线必须有一个自己的起手处：
 * 节点悬停时右边缘露出的小圆点（`.om-rel-handle`）。按住它拖到另一个节点上松手，
 * 就建立一条关联，方向由起点指向终点。
 *
 * 与 DragController 一样，【事件挂在图层上做委托】，监听器数量与节点数量无关。
 * 落点判定复用 DragController 的 `hitTest`，不再写第二套几何。
 */

import type { LayoutResult } from '../layout/types'
import type { Canvas } from './Canvas'
import { hitTest } from './DragController'

export interface RelationDragHooks {
  canvas: Canvas
  boxes: () => LayoutResult
  /** 可见节点 id（文档序）。 */
  order: () => readonly string[]
  /** 编辑态才允许画。 */
  enabled: () => boolean
  /** 松手落在另一个节点上。 */
  onCreate: (fromId: string, toId: string) => void
}

/** 指针移动超过这个距离才算「在画」，否则当成一次误触。 */
const THRESHOLD = 3

export class RelationDrag {
  private readonly path: SVGPathElement
  private pointerId: number | null = null
  private fromId: string | null = null
  private startX = 0
  private startY = 0
  private drawing = false
  /** 刚画完一次，紧随其后的 click 不该再被当成「选中并跳转」。 */
  private dragged = false

  constructor(
    private readonly layer: HTMLElement,
    svg: SVGSVGElement,
    private readonly hooks: RelationDragHooks,
  ) {
    // cls 只能给一个类名：Obsidian 的 createSvg 用 classList.add，带空格会抛错
    this.path = svg.createSvg('path', { cls: 'om-rel-draw', attr: { fill: 'none' } })
    this.path.addClass('is-hidden')
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
    this.path.remove()
  }

  get active(): boolean {
    return this.fromId !== null
  }

  /** 「刚才那下是画关联线吗」——供 click 处理器询问一次。 */
  consumeClick(): boolean {
    const was = this.dragged
    this.dragged = false
    return was
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.pointerId !== null || !this.hooks.enabled()) return
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.om-rel-handle')
    if (!handle) return
    const el = handle.closest<HTMLElement>('.om-node')
    const id = el?.dataset['nodeId']
    if (!id) return
    this.pointerId = e.pointerId
    this.fromId = id
    this.startX = e.clientX
    this.startY = e.clientY
    this.layer.setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId || !this.fromId) return
    const moved = Math.abs(e.clientX - this.startX) + Math.abs(e.clientY - this.startY)
    if (!this.drawing && moved < THRESHOLD) return
    this.drawing = true
    const rect = this.hooks.canvas.viewportRect()
    const point = this.hooks.canvas.toContent(rect, e.clientX, e.clientY)
    const from = this.hooks.boxes().get(this.fromId)
    if (!from) return
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = point.x
    const y2 = point.y
    const dx = Math.max(30, Math.abs(x2 - x1) * 0.5)
    this.path.setAttribute('d', `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`)
    this.path.removeClass('is-hidden')
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return
    const fromId = this.fromId
    const drawing = this.drawing
    this.reset()
    if (!fromId || !drawing) return
    this.dragged = true
    const rect = this.hooks.canvas.viewportRect()
    const point = this.hooks.canvas.toContent(rect, e.clientX, e.clientY)
    const target = hitTest(this.hooks.order(), this.hooks.boxes(), point.x, point.y)
    if (target.id && target.id !== fromId) this.hooks.onCreate(fromId, target.id)
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return
    this.reset()
  }

  private reset(): void {
    if (this.pointerId !== null && this.layer.hasPointerCapture(this.pointerId)) {
      this.layer.releasePointerCapture(this.pointerId)
    }
    this.pointerId = null
    this.fromId = null
    this.drawing = false
    this.path.addClass('is-hidden')
    this.path.setAttribute('d', '')
  }
}
