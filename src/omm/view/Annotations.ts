/**
 * 标注层：框、概要括号、标注气泡。
 *
 * 全部画进连线那张 SVG（在节点 DOM 层之下），因此框会自然地「垫」在节点背后。
 * 与连线一样，元素数量只跟标注数量有关，跟节点数量无关。
 *
 * 数据来自节点行尾的 `%%…%%`（见 core/annotations.ts），这里只负责几何。
 */

import type { MindNode } from '../core/types'
import { parseLineMarker, MODEVOL_COLORS, SCRIPT_COLORS, type ScriptMarkerType } from '../../script-types'
import { ANNOTATION_PAD, type Box, type LayoutResult } from '../layout/types'

/** 框 / 概要向外扩的留白（与布局层共用同一个值）。 */
const BOX_PAD = ANNOTATION_PAD
/** 概要括号离节点群的距离。 */
const SUMMARY_GAP = 12
/** 括号两端的短横长度。 */
const SUMMARY_TICK = 8
/** 标注气泡与节点的间距。 */
const CALLOUT_GAP = 8
const CALLOUT_PAD_X = 8
const CALLOUT_PAD_Y = 4
const CALLOUT_LINE_RATIO = 1.35

interface SpanGroup {
  /** 组内可见节点（用于无框时的兜底）。 */
  box: Box
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** 节点整棵子树的包围盒（折叠掉的后代不在 boxes 里，自然被忽略）。 */
function subtreeBox(node: MindNode, boxes: LayoutResult): Box | null {
  let acc: Box | null = boxes.get(node.id) ? { ...(boxes.get(node.id) as Box) } : null
  for (const child of node.children) acc = union(acc, subtreeBox(child, boxes))
  return acc
}

/** 「本节点 + 其后 span-1 个兄弟」这一组的包围盒。 */
function spanGroup(node: MindNode, span: number, boxes: LayoutResult): SpanGroup | null {
  const parent = node.parent
  if (!parent) return null
  const index = parent.children.indexOf(node)
  if (index < 0) return null
  const slice = parent.children.slice(index, index + Math.max(1, span))
  let box: Box | null = null
  for (const sibling of slice) box = union(box, subtreeBox(sibling, boxes))
  return box ? { box } : null
}

/** CJK 感知的宽度估算（SVG 文本没法在无 DOM 的环境里精确量）。 */
function estimateWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.56
  return w
}

export class Annotations {
  private readonly layer: SVGGElement
  private drawn: SVGElement[] = []

  constructor(svg: SVGSVGElement) {
    this.layer = svg.createSvg('g', { cls: 'om-anno-layer' })
    // 关联线箭头：单向只画终点，双向两端都画（auto-start-reverse 让同一个标记翻向）
    const defs = this.layer.createSvg('defs')
    defs.innerHTML =
      '<marker id="om-rel-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ' +
      'markerUnits="strokeWidth" orient="auto-start-reverse">' +
      '<path class="om-anno-rel-arrow" d="M0 0 L8 4 L0 8 Z"/></marker>'
  }

  render(nodes: MindNode[], boxes: LayoutResult, orientation: 'h' | 'v', fontSize: number): void {
    this.clear()
    // 关联线先建锚点索引：%%id=xxx%% 的节点
    const anchors = new Map<string, MindNode>()
    for (const node of nodes) {
      const anchor = node.annotations?.anchor
      if (anchor) anchors.set(anchor, node)
    }
    for (const node of nodes) {
      const rels = node.annotations?.rels ?? []
      rels.forEach((rel, index) => {
        const target = anchors.get(rel.target)
        if (!target) return
        const from = boxes.get(node.id)
        const to = boxes.get(target.id)
        if (from && to) this.drawRelation(node.id, index, from, to, rel.text, rel.both === true, fontSize)
      })
    }
    for (const node of nodes) {
      const annotation = node.annotations
      if (!annotation) continue
      const own = boxes.get(node.id)
      if (!own) continue

      if (annotation.box) {
        const group = spanGroup(node, annotation.box.span, boxes)
        if (group) this.drawBox(group.box, annotation.box.text, fontSize, node.id)
      }
      if (annotation.summary) {
        const group = spanGroup(node, annotation.summary.span, boxes)
        if (group) this.drawSummary(group.box, annotation.summary.text, orientation, fontSize, node.id)
      }
      if (annotation.callout && annotation.callout.text.trim() !== '') {
        this.drawCallout(own, annotation.callout.text, fontSize)
      }
    }
  }

  destroy(): void {
    this.clear()
    this.layer.remove()
  }

  private clear(): void {
    for (const el of this.drawn) el.remove()
    this.drawn = []
  }

  private push<T extends SVGElement>(el: T): T {
    this.drawn.push(el)
    return el
  }

  /** SVG 文本不能用 createSvg 的 text 选项，单独写 textContent。 */
  private text(content: string, attrs: Record<string, string>, cls = 'om-anno-label'): SVGTextElement {
    const el = this.push(this.layer.createSvg('text', { cls, attr: attrs }))
    el.textContent = content
    return el
  }

  /**
   * 带语义标签的标签文字：`#e 例子` 的 `#e` 画成彩色小标签，其余文字照常。
   * 标注里的文字和节点标题用同一套 `#x` 语法，不必再学第二种写法。
   */
  private label(content: string, attrs: Record<string, string>, cls = 'om-anno-label'): SVGTextElement {
    const marker = parseLineMarker(content)
    if (!marker) return this.text(content, attrs, cls)
    const el = this.push(this.layer.createSvg('text', { cls, attr: attrs }))
    const type = marker.type as ScriptMarkerType
    const color = SCRIPT_COLORS[type as keyof typeof SCRIPT_COLORS]
      ?? MODEVOL_COLORS[type as keyof typeof MODEVOL_COLORS]
      ?? 'currentColor'
    const tag = el.createSvg('tspan', { cls: 'om-anno-tag', attr: { fill: color } })
    tag.textContent = marker.label
    const rest = el.createSvg('tspan', { attr: { dx: '4' } })
    rest.textContent = content.slice(marker.textOffset)
    return el
  }

  private drawBox(box: Box, text: string, fontSize: number, nodeId: string): void {
    const rect = this.push(this.layer.createSvg('rect', {
      cls: 'om-anno-box',
      attr: {
        x: `${r(box.x - BOX_PAD)}`,
        y: `${r(box.y - BOX_PAD)}`,
        width: `${r(box.w + BOX_PAD * 2)}`,
        height: `${r(box.h + BOX_PAD * 2)}`,
        rx: '10',
        ry: '10',
      },
    }))
    // 点框 / 点标签都能打开编辑
    rect.setAttribute('data-anno', `box:${nodeId}`)
    if (text.trim() !== '') {
      const label = this.label(text, {
        x: `${r(box.x - BOX_PAD + 6)}`,
        y: `${r(box.y - BOX_PAD - 4)}`,
        'font-size': `${Math.round(fontSize * 0.8)}`,
      })
      label.setAttribute('data-anno', `box:${nodeId}`)
    }
  }

  private drawSummary(box: Box, text: string, orientation: 'h' | 'v', fontSize: number, nodeId: string): void {
    const size = Math.round(fontSize * 0.8)
    if (orientation === 'v') {
      // 向下组织图：括号横在整组下方
      const y = box.y + box.h + SUMMARY_GAP
      const x1 = box.x
      const x2 = box.x + box.w
      const d =
        `M${r(x1)} ${r(y - SUMMARY_TICK)}` +
        `L${r(x1 + SUMMARY_TICK)} ${r(y)}` +
        `L${r(x2 - SUMMARY_TICK)} ${r(y)}` +
        `L${r(x2)} ${r(y - SUMMARY_TICK)}`
      const path = this.push(this.layer.createSvg('path', { cls: 'om-anno-summary', attr: { d, fill: 'none' } }))
      path.setAttribute('data-anno', `summary:${nodeId}`)
      if (text.trim() !== '') {
        const label = this.label(text, {
          x: `${r((x1 + x2) / 2)}`,
          y: `${r(y + size + 4)}`,
          'font-size': `${size}`,
          'text-anchor': 'middle',
        })
        label.setAttribute('data-anno', `summary:${nodeId}`)
      }
      return
    }
    // 横向：括号竖在整组右侧
    const x = box.x + box.w + SUMMARY_GAP
    const y1 = box.y
    const y2 = box.y + box.h
    const d =
      `M${r(x + SUMMARY_TICK)} ${r(y1)}` +
      `L${r(x)} ${r(y1 + SUMMARY_TICK)}` +
      `L${r(x)} ${r(y2 - SUMMARY_TICK)}` +
      `L${r(x + SUMMARY_TICK)} ${r(y2)}`
    const path = this.push(this.layer.createSvg('path', { cls: 'om-anno-summary', attr: { d, fill: 'none' } }))
    path.setAttribute('data-anno', `summary:${nodeId}`)
    if (text.trim() !== '') {
      const label = this.label(text, {
        x: `${r(x + SUMMARY_TICK + 6)}`,
        y: `${r((y1 + y2) / 2 + size / 3)}`,
        'font-size': `${size}`,
      })
      label.setAttribute('data-anno', `summary:${nodeId}`)
    }
  }

  /** 两个节点之间的关联线：三次贝塞尔，两端各留一段水平出线。 */
  private drawRelation(
    sourceId: string,
    index: number,
    from: Box,
    to: Box,
    text: string,
    both: boolean,
    fontSize: number,
  ): void {
    const leftward = to.x + to.w <= from.x
    const x1 = leftward ? from.x : from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = leftward ? to.x + to.w : to.x
    const y2 = to.y + to.h / 2
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5)
    const c1x = x1 + (leftward ? -dx : dx)
    const c2x = x2 + (leftward ? dx : -dx)
    const d = `M${r(x1)} ${r(y1)}C${r(c1x)} ${r(y1)} ${r(c2x)} ${r(y2)} ${r(x2)} ${r(y2)}`
    // 透明宽线只负责命中，视觉线画在它上面
    const hit = this.push(this.layer.createSvg('path', { cls: 'om-anno-rel-hit', attr: { d } }))
    hit.setAttribute('data-anno', `rel:${sourceId}:${index}`)
    const path = this.push(this.layer.createSvg('path', {
      cls: 'om-anno-rel',
      attr: { d, fill: 'none', 'marker-end': 'url(#om-rel-arrow)' },
    }))
    if (both) path.setAttribute('marker-start', 'url(#om-rel-arrow)')
    path.setAttribute('data-anno', `rel:${sourceId}:${index}`)
    if (text.trim() !== '') {
      const size = Math.round(fontSize * 0.8)
      const label = this.label(text, {
        x: `${r((x1 + x2) / 2)}`,
        y: `${r((y1 + y2) / 2 - 4)}`,
        'font-size': `${size}`,
        'text-anchor': 'middle',
      })
      label.setAttribute('data-anno', `rel:${sourceId}:${index}`)
    }
  }

  private drawCallout(box: Box, text: string, fontSize: number): void {
    const size = Math.round(fontSize * 0.8)
    const lines = text.split(/<br\s*\/?>|\n/i).map((line) => line.trim()).filter((line) => line !== '')
    if (lines.length === 0) return
    const lineHeight = Math.round(size * CALLOUT_LINE_RATIO)
    const width = Math.max(...lines.map((line) => estimateWidth(line, size))) + CALLOUT_PAD_X * 2
    const height = lines.length * lineHeight + CALLOUT_PAD_Y * 2
    const x = box.x + box.w / 2 - width / 2
    const y = box.y - CALLOUT_GAP - height

    this.push(this.layer.createSvg('rect', {
      cls: 'om-anno-callout',
      attr: {
        x: `${r(x)}`,
        y: `${r(y)}`,
        width: `${r(width)}`,
        height: `${r(height)}`,
        rx: '8',
        ry: '8',
      },
    }))
    // 指向节点的尖角
    const tip = `M${r(box.x + box.w / 2 - 5)} ${r(y + height)}L${r(box.x + box.w / 2)} ${r(y + height + 5)}L${r(box.x + box.w / 2 + 5)} ${r(y + height)}Z`
    this.push(this.layer.createSvg('path', { cls: 'om-anno-callout', attr: { d: tip } }))

    lines.forEach((line, index) => {
      this.label(line, {
        x: `${r(x + CALLOUT_PAD_X)}`,
        y: `${r(y + CALLOUT_PAD_Y + (index + 1) * lineHeight - Math.round(lineHeight * 0.28))}`,
        'font-size': `${size}`,
      }, 'om-anno-callout-text')
    })
  }
}

/** 保留两位小数，和连线保持同样的精度。 */
function r(value: number): number {
  return Math.round(value * 100) / 100
}
