/**
 * 节点 DOM 的创建与复用。绝对定位 div + 复用池。
 *
 * 【不要每帧重建 DOM】——节点元素只按 id 认领与归还，属性只在真的变了的时候写。
 * 【不要挂 500 个监听器】——这里一个监听器都不挂，事件由 MindmapView 委托到容器上。
 */

import { finishRenderMath, renderMath } from 'obsidian'
import type { MindNode } from '../core/types'
import { sideOf, type NodeSide } from '../layout'
import type { Box, LayoutResult } from '../layout/types'
import { parseInline, tagsFor } from './inline'
import { taskOf } from '../core/task'
import { scriptMarkerOf } from '../core/scriptMarker'
import { renderBodyInto } from './body'
import { MODEVOL_LABELS, SCRIPT_LABELS, MODEVOL_COLORS, SCRIPT_COLORS, type ScriptMarkerType } from '../../script-types'

interface Slot {
  el: HTMLElement
  /** 标题卡片：节点只在这一层画边框与背景，备注是它下方的另一张卡片。 */
  headEl: HTMLElement
  textEl: HTMLElement
  badgeEl: HTMLElement  // lenscript marker 徽章；默认隐藏
  /** 备注下拉卡片（标题正下方），收起时整块隐藏。 */
  noteEl: HTMLElement
  bodyEl: HTMLElement   // 备注正文；与标题分开，各有各的背景
  bodyToggleEl: HTMLElement
  toggleEl: HTMLElement
  /** 拖拽画关联线的手柄，只在悬停时露出。 */
  relHandleEl: HTMLElement
  /** 上一次写进去的值，用来跳过没必要的 DOM 写入。null = 还没写过。 */
  text: string | null
  /** 上一次渲染的正文；与 text 分开缓存，标题改动不会让正文白重画一遍。 */
  body: string | null
  /** 上一次渲染正文时用的搜索词；搜索变化要重画高亮。 */
  bodyQuery: string
  searchKey: string
  transform: string
  w: number
  h: number
  hasToggle: boolean
  collapsed: boolean
  /** 备注是否展开（与折叠状态无关）。 */
  bodyOpen: boolean
  hasBody: boolean
  bodyToggleVisible: boolean
  /** 节点朝左生长（M9）：折叠按钮要挪到左边去。 */
  left: boolean
  selected: boolean
  dragging: boolean
  dropInto: boolean
  /** 上一次写的层级 class（1–6）。0 = 还没写过。 */
  level: number
  /** 上一次写的 marker 类型：null/undefined = 没写过 marker */
  marker: string | null
}

/** 视图注入的正文读取器。返回 null 表示这个节点当前不显示正文。 */
export interface BodySource {
  text(node: MindNode): string | null
  /** 正文是否展开（阅读模式恒为 true）。 */
  open(node: MindNode): boolean
  /** 这个节点有没有备注（与当前是否展开无关，用来决定下拉箭头的显隐）。 */
  has(node: MindNode): boolean
  /** 是否显示每节点的正文开关（阅读模式隐藏）。 */
  toggle: boolean
  /** 就地搜索词；命中的正文行会高亮。 */
  query?: string
}

export class NodeRenderer {
  private search: ReadonlyMap<string, readonly string[]> = new Map()
  setSearch(matches: ReadonlyMap<string, readonly string[]>): void { this.search = matches }
  private readonly active = new Map<string, Slot>()
  private readonly pool: Slot[] = []
  /**
   * 拖拽视觉状态存在这里，而不是由 DragController 直接改 DOM 的 class。
   *
   * 节点元素是【复用】的：拖拽中途来一次重绘，元素可能已经归还给另一个节点，
   * 外面挂上去的 class 就会留在错的节点上。状态在这一层，update 每次都会重新校准。
   */
  private dragging: ReadonlySet<string> = new Set()
  private dropInto: string | null = null
  /**
   * 这一帧新建的元素先攒在游离的 fragment 里，render 结束时【一次】插进图层（M10）。
   *
   * 首次渲染 1000 个节点就是 1000 次 appendChild，每一次都在一棵已经上屏的树上动土；
   * 攒起来一次插，浏览器只需要为它们做一遍样式解析。
   */
  private incoming: DocumentFragment | null = null

  constructor(private readonly layer: HTMLElement) {}

  /**
   * 把可见节点渲染到图层上。
   *
   * @param nodes 可见节点（文档序），来自 layout/visibleNodes
   * @param boxes 布局结果
   * @param selected 选中的节点 id（Ctrl+左键可多选，M6）
   * @param rootSide 根节点算哪一侧（M9）。它的父亲是虚拟 root，没有 Box 可比
   */
  render(
    nodes: MindNode[],
    boxes: LayoutResult,
    selected: ReadonlySet<string>,
    rootSide: NodeSide = 'right',
    body?: BodySource,
  ): void {
    const keep = new Set<string>()
    let needsMathFinish = false

    for (const node of nodes) {
      const box = boxes.get(node.id)
      if (!box) continue
      keep.add(node.id)
      const slot = this.active.get(node.id) ?? this.acquire(node.id)
      const parentBox = node.parent ? boxes.get(node.parent.id) : undefined
      if (this.update(slot, node, box, selected.has(node.id), sideOf(box, parentBox, rootSide), body)) {
        needsMathFinish = true
      }
    }

    for (const [id, slot] of this.active) {
      if (!keep.has(id)) {
        this.active.delete(id)
        this.release(slot)
      }
    }

    // 新建的元素统一在这里上屏。放在最后：位置、文字、class 都写完了才进 DOM，
    // 浏览器就不必为每个元素各算一次样式
    if (this.incoming) {
      this.layer.appendChild(this.incoming)
      this.incoming = null
    }

    // renderMath() 会把公式 DOM 同步造出来，但 MathJax 的自适应样式要在一批公式都
    // render 完之后统一 flush。一次 draw 最多调用一次，绝不能每个节点各 flush 一遍。
    if (needsMathFinish) {
      void finishRenderMath().catch((err: unknown) => {
        console.warn('[outline-mindmap] finishRenderMath failed', err)
      })
    }
  }

  /**
   * 拖拽视觉：`dragging` 是被拖走的整棵子树（置灰），`into` 是「放进它里面」的那个目标。
   *
   * 只动真正变了的那几个元素——拖拽中每帧都会调到这里，不能是 O(n) 的 DOM 写入。
   */
  setDragVisual(dragging: ReadonlySet<string>, into: string | null): void {
    for (const id of this.dragging) if (!dragging.has(id)) this.applyDragging(id, false)
    for (const id of dragging) if (!this.dragging.has(id)) this.applyDragging(id, true)
    this.dragging = dragging

    if (this.dropInto !== into) {
      if (this.dropInto !== null) this.applyDropInto(this.dropInto, false)
      if (into !== null) this.applyDropInto(into, true)
      this.dropInto = into
    }
  }

  destroy(): void {
    for (const slot of this.active.values()) slot.el.remove()
    for (const slot of this.pool) slot.el.remove()
    this.active.clear()
    this.pool.length = 0
    this.incoming = null
    this.dragging = new Set()
    this.dropInto = null
  }

  /** 备注正文元素：编辑框要精确盖在它上面，用真实 DOM 的矩形而不是估算。 */
  noteBodyElement(id: string): HTMLElement | null {
    const slot = this.active.get(id)
    if (!slot || slot.noteEl.hasClass('is-hidden')) return null
    return slot.bodyEl
  }

  /** 整张备注卡片（含内边距），正文编辑框盖这一整块。 */
  noteElement(id: string): HTMLElement | null {
    const slot = this.active.get(id)
    if (!slot || slot.noteEl.hasClass('is-hidden')) return null
    return slot.noteEl
  }

  // ── 内部 ────────────────────────────────────────────────────

  private acquire(id: string): Slot {
    const slot = this.pool.pop() ?? this.create()
    slot.el.dataset['nodeId'] = id
    slot.el.removeClass('is-hidden')
    // 复用池里的元素可能带着上一个节点的备注展开态：先收起来，update 会按当前状态重设
    slot.noteEl.addClass('is-hidden')
    slot.bodyToggleEl.removeClass('is-open')
    slot.bodyOpen = false
    slot.body = null
    this.active.set(id, slot)
    return slot
  }

  private release(slot: Slot): void {
    // 留在 DOM 里但隐藏。反复展开/折叠时能直接复用，不必重新创建。
    slot.el.addClass('is-hidden')
    delete slot.el.dataset['nodeId']
    this.pool.push(slot)
  }

  private create(): Slot {
    const el = createDiv({ cls: 'om-node' })
    const headEl = el.createDiv({ cls: 'om-node-head' })
    const textEl = headEl.createDiv({ cls: 'om-node-text' })
    const badgeEl = headEl.createDiv({ cls: 'om-node-badge is-hidden' })
    const bodyToggleEl = headEl.createDiv({ cls: 'om-body-toggle is-hidden' })
    // 关联线手柄：从节点边缘拖到另一个节点就画一条关联线
    const relHandleEl = headEl.createDiv({ cls: 'om-rel-handle' })
    const noteEl = el.createDiv({ cls: 'om-note is-hidden' })
    const bodyEl = noteEl.createDiv({ cls: 'om-node-body' })
    // 折叠按钮朝着子节点那一侧（分支向右 → 右侧，向左 → 左侧），点击区靠 CSS 撑大
    const toggleEl = el.createDiv({ cls: 'om-toggle' })
    this.incoming ??= createFragment()
    this.incoming.appendChild(el)
    return {
      el,
      headEl,
      textEl,
      badgeEl,
      noteEl,
      bodyEl,
      bodyToggleEl,
      toggleEl,
      relHandleEl,
      text: null,
      body: null,
      bodyQuery: '',
      searchKey: '',
      transform: '',
      w: -1,
      h: -1,
      hasToggle: true,
      collapsed: false,
      bodyOpen: false,
      hasBody: false,
      bodyToggleVisible: false,
      left: false,
      selected: false,
      dragging: false,
      dropInto: false,
      level: 0,
      marker: null,
    }
  }

  /**
   * 把内联 Markdown 建成真实 DOM 填进节点文字区。
   *
   * 用 createEl + appendText 而不是 innerHTML：笔记里的 `<script>`、
   * `<img onerror=…>` 到了文本节点就只是字符（陷阱 13），
   * 不存在「哪天漏了一次转义」这种可能。
   */
  /**
   * 标题渲染：任务项先画一个复选框，再渲染去掉 `[ ] ` 前缀的文字。
   * 复选框尺寸由 CSS 变量控制，与 measure.ts 的 `taskBox()` 保持同一套数值。
   */
  static renderTitle(host: HTMLElement, text: string, terms: readonly string[] = []): boolean {
    const task = taskOf(text)
    if (!task) return NodeRenderer.renderInline(host, text, terms)
    host.empty()
    const box = host.createSpan({ cls: `om-task${task.checked ? ' is-checked' : ''}` })
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(task.checked))
    const body = host.createSpan({ cls: 'om-task-text' })
    return NodeRenderer.renderInline(body, task.rest, terms)
  }

  static renderInline(host: HTMLElement, text: string, terms: readonly string[] = []): boolean {
    host.empty()
    let renderedMath = false
    const segments = parseInline(text)
    const visible = segments.map(s => s.text).join('')
    const ranges: [number, number][] = []
    for (const term of new Set(terms.map(t => parseInline(t).map(s => s.text).join('')))) {
      if (!term) continue
      let from = 0, at: number
      while ((at = visible.indexOf(term, from)) >= 0) {
        ranges.push([at, at + term.length])
        from = at + term.length
      }
    }
    ranges.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const range of ranges) {
      const last = merged.at(-1)
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
      else merged.push([...range])
    }
    let offset = 0, rangeIndex = 0
    for (const seg of segments) {
      // 内层在前、外层在后，所以从后往前套：strong > em > mark > s > span.om-link > 文字
      let target = host
      for (const { tag, cls } of tagsFor(seg).reverse()) {
        target = target.createEl(tag, cls ? { cls } : undefined)
      }
      if (seg.color) target.style.color = seg.color
      if (seg.background) target.style.backgroundColor = seg.background
      if (seg.math) {
        try {
          const math = renderMath(seg.text, false)
          math.addClass('om-math')
          math.setAttribute('data-om-formula', seg.text)
          target.appendChild(math)
          renderedMath = true
        } catch {
          // MathJax 尚未就绪或公式本身异常时，保留可编辑的源码。
          target.appendText(`$${seg.text}$`)
        }
      } else {
        // 不能用 host.setText：一行里有「普通文字 + 强调/链接/公式 + 普通文字」时，
        // 后一个纯文字片段会把前面已经创建的子节点整棵清掉。appendText 才是逐片段拼接。
        let start = 0
        while (start < seg.text.length) {
          while (merged[rangeIndex] && merged[rangeIndex]![1] <= offset + start) rangeIndex++
          const range = merged[rangeIndex]
          const marked = range !== undefined && range[0] <= offset + start
          const end = Math.min(seg.text.length, range ? (marked ? range[1] : range[0]) - offset : seg.text.length)
          const parent = marked ? target.createEl('mark', { cls: 'om-search-match' }) : target
          parent.appendText(seg.text.slice(start, end))
          start = end
        }
      }
      offset += seg.text.length
    }
    return renderedMath
  }

  private applyDragging(id: string, on: boolean): void {
    const slot = this.active.get(id)
    if (!slot || slot.dragging === on) return
    slot.el.classList.toggle('is-dragging', on)
    slot.dragging = on
  }

  private applyDropInto(id: string, on: boolean): void {
    const slot = this.active.get(id)
    if (!slot || slot.dropInto === on) return
    slot.el.classList.toggle('is-drop-into', on)
    slot.dropInto = on
  }

  private update(
    slot: Slot,
    node: MindNode,
    box: Box,
    selected: boolean,
    side: NodeSide,
    body?: BodySource,
  ): boolean {
    let renderedMath = false
    const terms = this.search.get(node.id)
    const searchKey = terms ? JSON.stringify(terms) : ''
    // `## #e 同类数` 这类写法：标记走徽章，标题只显示正文
    const leading = scriptMarkerOf(node.text)
    const titleText = leading ? leading.rest : node.text
    slot.el.toggleClass('is-search-match', terms !== undefined)
    if (slot.text !== node.text || slot.searchKey !== searchKey) {
      renderedMath = NodeRenderer.renderTitle(slot.textEl, titleText, terms)
      slot.text = node.text
      slot.searchKey = searchKey
    }

    // 正文：只有视图给了文字、且处于展开状态时才铺出来
    const bodyText = body?.text(node) ?? null
    const bodyOpen = bodyText !== null && (body?.open(node) ?? false)
    // 收起时正文文字是 null，但箭头要留着——不点开它就永远打不开备注
    const bodyToggleVisible = body?.toggle === true && (body?.has(node) ?? false)
    if (slot.bodyToggleVisible !== bodyToggleVisible) {
      slot.bodyToggleEl.toggleClass('is-hidden', !bodyToggleVisible)
      slot.bodyToggleVisible = bodyToggleVisible
    }
    if (slot.bodyOpen !== bodyOpen) {
      slot.noteEl.toggleClass('is-hidden', !bodyOpen)
      slot.bodyToggleEl.classList.toggle('is-open', bodyOpen)
      slot.bodyOpen = bodyOpen
    }
    if (bodyOpen && (slot.body !== bodyText || slot.bodyQuery !== (body?.query ?? '') || slot.bodyEl.hasClass('is-hidden'))) {
      renderedMath = renderBodyInto(slot.bodyEl, bodyText, body?.query) || renderedMath
      slot.body = bodyText
      slot.bodyQuery = body?.query ?? ''
      slot.bodyEl.removeClass('is-hidden')
    }
    const hasBody = bodyText !== null
    if (slot.hasBody !== hasBody) {
      slot.el.toggleClass('has-body', hasBody)
      slot.hasBody = hasBody
    }

    // lenscript marker 徽章（独立 marker 行，或标题文字开头的 `#e`）
    const marker = node.marker ?? leading?.marker ?? null
    if (slot.marker !== marker) {
      slot.marker = marker
      if (marker) {
        const m = marker as ScriptMarkerType
        const label = MODEVOL_LABELS[m as keyof typeof MODEVOL_LABELS]
          ?? SCRIPT_LABELS[m as keyof typeof SCRIPT_LABELS]
          ?? marker
        const color = SCRIPT_COLORS[m as keyof typeof SCRIPT_COLORS]
          ?? MODEVOL_COLORS[m as keyof typeof MODEVOL_COLORS]
          ?? '#4b5563'
        slot.badgeEl.setText(label)
        slot.badgeEl.style.background = color
        slot.badgeEl.removeClass('is-hidden')
      } else {
        slot.badgeEl.addClass('is-hidden')
        slot.badgeEl.style.background = ''
        slot.badgeEl.setText('')
      }
    }

    const transform = `translate(${box.x}px, ${box.y}px)`
    // 三项一起写：都变了的时候（新节点、文字改动引起的重排）只碰一次 style
    if (slot.transform !== transform || slot.w !== box.w || slot.h !== box.h) {
      slot.el.setCssStyles({ transform, width: `${box.w}px`, height: `${box.h}px` })
      slot.transform = transform
      slot.w = box.w
      slot.h = box.h
    }

    const hasToggle = node.children.length > 0
    if (slot.hasToggle !== hasToggle) {
      slot.toggleEl.toggleClass('is-hidden', !hasToggle)
      slot.hasToggle = hasToggle
    }
    if (hasToggle && slot.collapsed !== node.collapsed) {
      slot.toggleEl.classList.toggle('is-collapsed', node.collapsed)
      slot.collapsed = node.collapsed
    }
    const left = side === 'left'
    if (slot.left !== left) {
      slot.el.classList.toggle('is-left', left)
      slot.left = left
    }
    // 多彩标题的层级 class：列表层级可以超过 6，色板按 6 一循环
    const level = ((node.depth - 1) % 6) + 1
    if (slot.level !== level) {
      slot.el.removeClass(`om-l${slot.level}`)
      slot.el.addClass(`om-l${level}`)
      slot.level = level
    }
    if (slot.selected !== selected) {
      slot.el.classList.toggle('is-selected', selected)
      slot.selected = selected
    }

    // 复用池给出的元素可能带着上一个节点的拖拽 class，每次都按当前状态校准一次
    const dragging = this.dragging.has(node.id)
    if (slot.dragging !== dragging) {
      slot.el.classList.toggle('is-dragging', dragging)
      slot.dragging = dragging
    }
    const dropInto = this.dropInto === node.id
    if (slot.dropInto !== dropInto) {
      slot.el.classList.toggle('is-drop-into', dropInto)
      slot.dropInto = dropInto
    }
    return renderedMath
  }
}
