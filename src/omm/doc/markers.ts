/**
 * 编辑器里的行尾注解：把 `%%callout "…"%%`、`%%id=r1%%` 这类标记换成小图标。
 *
 * 数据仍然只存在 Markdown 里（见 core/annotations.ts）。这一层只做显示：
 * - 只认【已知注解】，用户自己写的普通 `%%注释%%` 原样保留；
 * - 光标 / 选区碰到某一段标记时，那一段立刻露出源码，可以直接改；
 * - 代码块（含行内代码）里不替换；
 * - 只扫可视区域，长文档不做全文扫描。
 *
 * 【为什么不在阅读视图里也做】：`%%…%%` 本来就是 Obsidian 注释，阅读视图里
 * Obsidian 自己就会隐藏它，用不着插件再画一遍。
 */

import { getLanguage, setIcon } from 'obsidian'
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { annotationKind, type AnnotationKind } from '../core/annotations'

/** 行内任意一个 `%%…%%`。中间允许出现单个 `%`（链接里的 %E4 之类）。 */
const MARKER_RE = /%%((?:[^%]|%(?!%))*?)%%/g

interface KindMeta {
  icon: string
  zh: string
  en: string
}

const KIND_META: Record<AnnotationKind, KindMeta> = {
  box: { icon: 'square', zh: '外框', en: 'Frame' },
  summary: { icon: 'list', zh: '概要', en: 'Summary' },
  callout: { icon: 'message-square', zh: '标注', en: 'Callout' },
  anchor: { icon: 'hash', zh: '锚点', en: 'Anchor' },
  rel: { icon: 'git-branch', zh: '关联', en: 'Relation' },
  float: { icon: 'move', zh: '自由位置', en: 'Free position' },
}

function isZh(): boolean {
  try {
    return getLanguage().toLowerCase().startsWith('zh')
  } catch {
    return false
  }
}

/** 标记里第一段引号文字：气泡内容 / 框标题 / 连线文字。 */
function quotedText(token: string): string {
  const match = /"([\s\S]*?)"/.exec(token)
  return match?.[1]?.trim() ?? ''
}

class AnnotationChipWidget extends WidgetType {
  constructor(
    private readonly kind: AnnotationKind,
    private readonly token: string,
    private readonly from: number,
  ) {
    super()
  }

  private get meta(): KindMeta {
    return KIND_META[this.kind]
  }

  toDOM(view: EditorView): HTMLElement {
    const meta = this.meta
    const text = this.kind === 'callout' ? quotedText(this.token) : ''
    const label = isZh() ? meta.zh : meta.en
    const hint = text ? `${label}：${text}\n%%${this.token}%%` : `${label}\n%%${this.token}%%`

    const chip = document.createElement('span')
    chip.className = `ls-anno-chip is-${this.kind}`
    chip.title = hint
    chip.setAttribute('aria-label', hint)
    // 点一下把光标放进标记里：装饰随即让位，露出源码可以直接编辑
    chip.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ selection: { anchor: this.from + 2 } })
      view.focus()
    })

    const iconEl = document.createElement('span')
    iconEl.className = 'ls-anno-chip-icon'
    setIcon(iconEl, meta.icon)
    chip.appendChild(iconEl)

    if (text) {
      const textEl = document.createElement('span')
      textEl.className = 'ls-anno-chip-text'
      textEl.textContent = text.length > 16 ? `${text.slice(0, 16)}…` : text
      chip.appendChild(textEl)
    }
    return chip
  }

  override eq(other: WidgetType): boolean {
    return other instanceof AnnotationChipWidget &&
      other.kind === this.kind &&
      other.token === this.token &&
      other.from === this.from
  }

  /** 让点击事件走到我们自己的 mousedown 处理里，而不是被当作普通文字吞掉。 */
  override ignoreEvent(): boolean {
    return false
  }

  override get estimatedHeight(): number {
    return -1
  }
}

/** 光标 / 选区正好落在（不含两端）这段标记里 → 露出源码。 */
function revealed(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from < to && range.to > from) return true
  }
  return false
}

/** 在代码块 / 行内代码里不替换。 */
function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (/code/i.test(node.name)) return true
    node = node.parent
  }
  return false
}

interface MarkerHit {
  start: number
  end: number
  token: string
}

/** 一行里所有「已知注解」的 `%%…%%`，按出现位置排序。 */
function annotationHits(text: string): MarkerHit[] {
  const hits: MarkerHit[] = []
  for (const match of text.matchAll(MARKER_RE)) {
    const token = match[1] ?? ''
    if (!annotationKind(token)) continue
    const start = match.index ?? 0
    hits.push({ start, end: start + match[0].length, token })
  }
  return hits
}

/**
 * 哪些标记属于「行尾注解链」。
 *
 * 一行可能连着写好几个注解（`%%callout "…"%% %%id=r1%%`），只有最后一段是
 * 严格意义上的行尾。从最后一个往前找，只要两段之间只有空白，就都算链上。
 */
function trailingFrom(text: string, hits: MarkerHit[]): number {
  let last = hits.length
  let nextStart = text.length
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]
    if (!hit) break
    if (text.slice(hit.end, nextStart).trim() !== '') break
    last = i
    nextStart = hit.start
  }
  return last
}

function build(view: EditorView): DecorationSet {
  try {
    const builder = new RangeSetBuilder<Decoration>()
    const doc = view.state.doc
    for (const visible of view.visibleRanges) {
      let pos = visible.from
      while (pos <= visible.to) {
        const line = doc.lineAt(pos)
        if (line.from > visible.to) break
        const text = line.text
        const hits = annotationHits(text)
        const firstTrailing = trailingFrom(text, hits)
        for (let i = firstTrailing; i < hits.length; i++) {
          const hit = hits[i]
          if (!hit) continue
          const from = line.from + hit.start
          const to = line.from + hit.end
          if (revealed(view.state, from, to)) continue
          if (insideCode(view.state, from)) continue
          // 注意：这里【不】用 Decoration.replace。
          // Obsidian live preview 自己也会处理 `%%…%%` 注释，两个替换装饰叠在同一段
          // 会触发 CodeMirror 的重叠检查、把整个编辑器弄坏。改用「mark 隐藏 + 行尾挂组件」：
          // 两个 mark 可以安全嵌套，原始文字仍在文档里，光标进去时只要不画装饰就复原。
          builder.add(from, to, Decoration.mark({ class: 'ls-anno-hidden' }))
          builder.add(to, to, Decoration.widget({
            widget: new AnnotationChipWidget(annotationKind(hit.token) ?? 'box', hit.token, from),
            side: 1,
          }))
        }
        pos = line.to + 1
      }
    }
    return builder.finish()
  } catch {
    // 装饰出问题绝不能拖垮编辑器：退回什么都不画
    return Decoration.none
  }
}

/** 注册进 Obsidian 的 CodeMirror 扩展。 */
export function annotationMarkers(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = build(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
