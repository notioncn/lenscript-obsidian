/**
 * 节点正文（标题与第一个子节点之间的段落）的渲染。
 *
 * 【为什么按源行逐行渲染，而不是整段交给 MarkdownRenderer】
 * 布局高度是在 measure.ts 里用 canvas 量出来的（红线：不做逐节点重排）。
 * 只有「一行 = 一个块、行内格式走 parseInline」这种可预测的排版，
 * DOM 的实际高度才会和测量结果逐像素对上；交给块级 Markdown 渲染器，
 * 列表、代码块、段间距都会各涨一点，节点盒子立刻对不齐。
 */

import { NodeRenderer } from './NodeRenderer'
import { parseLineMarker, MODEVOL_COLORS, SCRIPT_COLORS } from '../../script-types'

/**
 * 把 `#e` 这类语义标记画成彩色小标签。返回去掉标记后的文字。
 *
 * 正文、标注的每一行都走这里，和节点标题的徽章用同一套语法与配色。
 */
export function appendMarkerChip(host: HTMLElement, text: string): string {
  const hit = parseLineMarker(text)
  if (!hit) return text
  const color = SCRIPT_COLORS[hit.type as keyof typeof SCRIPT_COLORS]
    ?? MODEVOL_COLORS[hit.type as keyof typeof MODEVOL_COLORS]
    ?? 'var(--text-muted)'
  const chip = host.createSpan({ cls: 'om-tag', text: hit.label })
  chip.style.setProperty('--om-tag-color', color)
  return text.slice(hit.textOffset)
}

/**
 * 把正文铺进 host。返回是否有公式需要 MathJax 收尾。
 *
 * 空白行也保留一个占位，保证「空行 = 一行高度」和 measureBody 一致。
 */
export function renderBodyInto(host: HTMLElement, text: string, query = ''): boolean {
  host.empty()
  host.toggleClass('has-content', text !== '')
  const needle = query.trim().toLowerCase()
  let renderedMath = false
  for (const line of text.split('\n')) {
    const lineEl = host.createDiv({ cls: 'om-body-line' })
    if (needle && line.toLowerCase().includes(needle)) lineEl.addClass('is-search-hit')
    if (line.trim() === '') {
      lineEl.addClass('is-blank')
      lineEl.setText('\u00a0')
      continue
    }
    // 列表行只做缩进提示，符号原样保留：正文是用户手写的 Markdown，不能被悄悄改写
    if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line)) lineEl.addClass('is-list')
    // 行首的 `#e ` 语义标记：画成标签，剩余文字照常走行内 Markdown
    const rest = appendMarkerChip(lineEl, line)
    if (NodeRenderer.renderInline(lineEl, rest)) renderedMath = true
  }
  return renderedMath
}
