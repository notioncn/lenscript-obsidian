/**
 * 布局分发。三种方向：向右 / 向左 / 两侧（M9）。
 *
 * 【禁止】import 任何 obsidian API。
 */

import type { MindNode, MindTree } from '../core/types'
import { layoutBoth, layoutLeft, layoutRight } from './tidy'
import { layoutDown } from './vertical'
import type { Box, LayoutDirection, LayoutOptions, LayoutResult } from './types'

export * from './types'
export { layoutBoth, layoutLeft, layoutRight } from './tidy'
export { layoutDown } from './vertical'

/** 可选的布局方向，按菜单里的先后顺序。工具栏据此建菜单，不必自己维护一份清单。 */
export const LAYOUT_DIRECTIONS: readonly LayoutDirection[] = ['right', 'left', 'both']

export function layout(tree: MindTree, options: LayoutOptions): LayoutResult {
  const result = layoutBase(tree, options)
  // 自由主题：布局完成后按 `%%float x y%%` 平移整棵子树
  applyFloats(tree, result)
  return result
}

function layoutBase(tree: MindTree, options: LayoutOptions): LayoutResult {
  if (options.structure === 'org-down') return layoutDown(tree, options)
  switch (options.direction) {
    case 'right':
      return layoutRight(tree, options)
    case 'left':
      return layoutLeft(tree, options)
    case 'both':
      return layoutBoth(tree, options)
  }
}

/** 整棵子树平移（自由主题连后代一起搬走）。 */
function shiftSubtree(node: MindNode, dx: number, dy: number, boxes: LayoutResult): void {
  const own = boxes.get(node.id)
  if (own) {
    own.x += dx
    own.y += dy
  }
  if (node.collapsed) return
  for (const child of node.children) shiftSubtree(child, dx, dy, boxes)
}

/**
 * 自由主题：带 `%%float x=… y=…%%` 的节点，中心点摆到父节点中心 + 偏移处，子树整体跟着走。
 *
 * 父节点是虚拟 root（自由根）时，锚点取所有根节点包围盒的中心。
 * 这一步只挪坐标，不改树结构；连线由 Connectors 跳过，因此自由主题不与父节点相连。
 */
function applyFloats(tree: MindTree, boxes: LayoutResult): void {
  const rootCenter = (): { x: number; y: number } => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const child of tree.root.children) {
      // 自由主题不参与中心计算：否则每加一个自由文本，锚点就被自己推偏一次
      if (child.annotations?.float) continue
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

  const walk = (node: MindNode): void => {
    for (const child of node.children) {
      const float = child.annotations?.float
      const own = boxes.get(child.id)
      if (float && own) {
        const parentBox = node.depth > 0 ? boxes.get(node.id) : undefined
        const center = parentBox
          ? { x: parentBox.x + parentBox.w / 2, y: parentBox.y + parentBox.h / 2 }
          : rootCenter()
        const dx = center.x + float.x - (own.x + own.w / 2)
        const dy = center.y + float.y - (own.y + own.h / 2)
        shiftSubtree(child, dx, dy, boxes)
      }
      walk(child)
    }
  }
  walk(tree.root)
}

/** 节点朝哪一侧生长。折叠按钮的位置、连线的接点、水平方向键的含义都按它来。 */
export type NodeSide = 'left' | 'right'

/**
 * 节点相对父节点在哪一侧。
 *
 * 纯几何判断，不看 direction：两侧布局里同一次布局的左右两列都要认对，
 * 而每个节点自己的 Box 已经把答案写在坐标里了。
 *
 * @param parentBox 父节点的 Box。根节点的父亲是不渲染的虚拟 root，没有 Box → 用 fallback
 */
export function sideOf(box: Box, parentBox: Box | undefined, fallback: NodeSide): NodeSide {
  if (!parentBox) return fallback
  return box.x + box.w <= parentBox.x ? 'left' : 'right'
}

/**
 * 根节点算哪一侧。
 *
 * 两侧布局的根两边都有子节点，本来无所谓左右；取「右」是为了跟默认布局一致——
 * 折叠按钮和 →/← 的含义不会因为换了个布局就跳到相反的一边。
 */
export function rootSide(direction: LayoutDirection): NodeSide {
  return direction === 'left' ? 'left' : 'right'
}

/**
 * 文档序遍历「当前可见」的节点：折叠节点自身可见，其后代不可见。
 *
 * 与 layout() 的可见性判定必须完全一致——渲染层拿这个列表去取 Box。
 */
export function visibleNodes(tree: MindTree): MindNode[] {
  const out: MindNode[] = []
  const walk = (n: MindNode): void => {
    for (const c of n.children) {
      out.push(c)
      if (!c.collapsed) walk(c)
    }
  }
  walk(tree.root)
  return out
}

/**
 * 一个节点连同它【当前可见】的后代的外接矩形（M10：展开 / 折叠后的视野跟随）。
 *
 * 折叠着的节点后代没有 Box，结果自然收缩成它自己那一个盒子——
 * 「折叠时同步收起视野」不需要任何特判，折叠前后各算一次就够了。
 *
 * @returns 节点本身不在布局结果里（被折叠的祖先藏起来了）时返回 null
 */
export function subtreeBounds(node: MindNode, boxes: LayoutResult): Box | null {
  const own = boxes.get(node.id)
  if (!own) return null
  let minX = own.x
  let minY = own.y
  let maxX = own.x + own.w
  let maxY = own.y + own.h
  const walk = (n: MindNode): void => {
    if (n.collapsed) return // 后代都没有 Box，不必再往下走
    for (const c of n.children) {
      const b = boxes.get(c.id)
      if (b) {
        if (b.x < minX) minX = b.x
        if (b.y < minY) minY = b.y
        if (b.x + b.w > maxX) maxX = b.x + b.w
        if (b.y + b.h > maxY) maxY = b.y + b.h
      }
      walk(c)
    }
  }
  walk(node)
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 内容外接矩形。空布局返回零矩形。 */
export function boundsOf(result: LayoutResult): Box {
  if (result.size === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of result.values()) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
