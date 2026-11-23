/**
 * 节点文字开头的语义标记（`#e 例子`、`#s 场景` …）。
 *
 * 既支持独立的 marker 行，也支持 `## #e 同类数` 这种把标记写进标题文字里的写法。
 * 这里只做「显示层」的拆分：文档里的文字一个字节都不改，改名 / 写回仍是原文。
 *
 * 【禁止】import 任何 obsidian API。
 */

import { parseLineMarker, type ScriptMarkerType } from '../../script-types'

export interface LeadingMarker {
  marker: ScriptMarkerType
  /** 去掉标记后的文字。 */
  rest: string
}

/** 文字开头若有 `#x ` 语义标记，拆出来；没有返回 null。 */
export function scriptMarkerOf(text: string): LeadingMarker | null {
  const hit = parseLineMarker(text)
  if (!hit) return null
  return { marker: hit.type, rest: text.slice(hit.textOffset) }
}
