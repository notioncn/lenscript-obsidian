/**
 * 向下组织图（org-down）布局。
 *
 * 与 tidy.ts 的横向布局是同一套思路，只是把两个轴对调：
 *  - 横向布局：子树各占一条「水平带」，兄弟在垂直方向排队；
 *  - 向下布局：子树各占一条「竖直带」，兄弟在水平方向排队。
 * 因此同样两趟遍历（后序算子树宽度，前序切带），O(n)，不需要轮廓合并。
 *
 * 纵向不强制对齐层：每个节点的子节点紧贴自己底部往下排。
 * 这样节点高度不等（有的带正文）时也绝不会重叠，org 图的层级仍然一眼可读。
 *
 * 【禁止】import 任何 obsidian API。
 */

import type { MindNode, MindTree } from '../core/types'
import { ANNOTATION_PAD, type Box, type LayoutOptions, type LayoutResult } from './types'

interface Item {
  node: MindNode
  w: number
  h: number
  /** 折叠时为空数组。 */
  children: Item[]
  /** 子节点横向排开占的总宽度（含间距）。 */
  blockW: number
  /** 整棵子树占据的横向宽度。 */
  extentW: number
  /** 整棵子树占据的纵向高度：自身 + 间距 + 最高的一棵子树。 */
  extentH: number
}

/** 每个兄弟是否落在某个外框 / 概要的覆盖范围内（与 tidy.ts 同义，只是沿 x 轴）。 */
function coverageOf(items: readonly Item[]): boolean[] {
  const covered = new Array<boolean>(items.length).fill(false)
  for (let i = 0; i < items.length; i++) {
    const box = items[i]!.node.annotations?.box
    const summary = items[i]!.node.annotations?.summary
    const span = Math.max(box?.span ?? 0, summary?.span ?? 0)
    if (span <= 0) continue
    for (let k = i; k < Math.min(items.length, i + span); k++) covered[k] = true
  }
  return covered
}

function boundaryExtra(covered: readonly boolean[], index: number): number {
  return index > 0 && covered[index] !== covered[index - 1] ? ANNOTATION_PAD * 2 : 0
}

function build(node: MindNode, options: LayoutOptions): Item {
  const size = options.measure(node)
  const children = node.collapsed ? [] : node.children.map((child) => build(child, options))
  const covered = coverageOf(children)
  let blockW = 0
  let tallest = 0
  children.forEach((child, index) => {
    blockW += child.extentW
    if (index > 0) blockW += options.hGap + boundaryExtra(covered, index)
    tallest = Math.max(tallest, child.extentH)
  })
  const extentW = children.length > 0 ? Math.max(size.w, blockW) : size.w
  const extentH = size.h + (children.length > 0 ? options.vGap + tallest : 0)
  return { node, w: size.w, h: size.h, children, blockW, extentW, extentH }
}

/**
 * 摆放一棵子树。
 *
 * @param left 子树所占竖直带的最左边
 * @param top  节点自身的顶边
 */
function place(item: Item, left: number, top: number, out: LayoutResult, options: LayoutOptions): void {
  const x = left + (item.extentW - item.w) / 2
  out.set(item.node.id, { x, y: top, w: item.w, h: item.h })
  if (item.children.length === 0) return

  const childTop = top + item.h + options.vGap
  const covered = coverageOf(item.children)
  let cursor = left + (item.extentW - item.blockW) / 2
  item.children.forEach((child, index) => {
    if (index > 0) cursor += options.hGap + boundaryExtra(covered, index)
    place(child, cursor, childTop, out, options)
    cursor += child.extentW
  })
}

/** 向下组织图。多个 H1 在垂直方向依次排开，与横向布局一致。 */
export function layoutDown(tree: MindTree, options: LayoutOptions): LayoutResult {
  const out: LayoutResult = new Map()
  let top = 0
  for (const root of tree.root.children) {
    const item = build(root, options)
    place(item, 0, top, out, options)
    top += item.extentH + options.rootGap
  }
  return out
}
