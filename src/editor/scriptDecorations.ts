/**
 * CodeMirror 6 装饰器扩展
 * 为段首 #d #e #v #t #c 和 #s #a #r #l #p #x 标记添加可视化装饰
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view"
import { RangeSetBuilder } from "@codemirror/state"
import {
  MODEVOL_COLORS,
  MODEVOL_LABELS,
  MODEVOL_MARKER_REGEX,
  SCRIPT_COLORS,
  SCRIPT_LABELS,
  SCRIPT_MARKER_REGEX,
  isModevolType,
  isScriptType,
} from "../script-types"
import { getTags, tagConfigEffect } from "./tagRuntime"
import { matchTagAtLine } from "../core/tags"

/** 段首标记的 inline widget：把 "#d" / "#s" 替换为“描述/场景”等文字徽章 */
class MarkerWidget extends WidgetType {
  constructor(
    private marker: string,
    private label: string,
    private color: string,
    private cssClass: string,
  ) {
    super()
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span")
    span.className = `ls-marker ls-marker-type ${this.cssClass}`
    span.style.background = this.color
    span.style.color = "#fff"
    span.textContent = this.label
    span.title = `${this.label}（${this.marker}）`
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
  get estimatedHeight(): number {
    return 22
  }
  eq(other: WidgetType): boolean {
    if (!(other instanceof MarkerWidget)) return false
    return (
      other.marker === this.marker &&
      other.label === this.label &&
      other.color === this.color &&
      other.cssClass === this.cssClass
    )
  }
}

/** 计算整段着色的 line decoration */
function buildDecorations(view: EditorView): DecorationSet {
  try {
    return buildDecorationsUnsafe(view)
  } catch {
    // 装饰器异常绝不能阻断编辑器渲染（否则整个笔记打不开）
    return Decoration.none
  }
}

function buildDecorationsUnsafe(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  const tags = getTags()

  // 只处理可视区域，长文档不做全量扫描
  for (const visible of view.visibleRanges) {
    let lineNo = doc.lineAt(visible.from).number
    const lastLine = doc.lineAt(visible.to).number

    for (; lineNo <= lastLine; lineNo++) {
      const line = doc.line(lineNo)
      // 标题行允许写成 `## #s 场景名`：跳过标题前缀再匹配标签
      const headingPrefix = line.text.match(/^(#{1,6}[ \t]+)/)?.[1].length ?? 0
      const matched = matchTagAtLine(line.text.slice(headingPrefix), tags)
      if (!matched) continue
      const tag = matched.tag
      const markerFrom = line.from + headingPrefix

      // 顺序必须按 from 升序、同一 from 时 to 升序：
      // 先加零长度的行装饰，再加替换标记，否则 RangeSetBuilder 会抛错
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: tag.blockClass,
          attributes: { style: `--ls-tag-color:${tag.color}` },
        }),
      )
      builder.add(
        markerFrom,
        markerFrom + matched.marker.length,
        Decoration.replace({
          widget: new MarkerWidget(matched.marker, tag.label, tag.color, tag.badgeClass),
          inclusive: false,
        }),
      )
    }
  }

  return builder.finish()
}

/**
 * 暴露给 Obsidian plugin 的 CodeMirror ViewPlugin
 * registerEditorExtension 时传入
 */
export const scriptDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      const tagChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(tagConfigEffect)),
      )
      if (update.docChanged || update.viewportChanged || tagChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
)
