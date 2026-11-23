/**
 * 选中文本转换（纯逻辑）
 *
 * any-menu 的「Quick Conversion」内核：把一段选中文字按规则变成另一段。
 * 只保留常用、可预期的规则；不依赖 Obsidian，可直接 Node 单测。
 */

export type TransformId =
  | "bold"
  | "italic"
  | "code"
  | "highlight"
  | "wiki"
  | "tag-d"
  | "tag-s"
  | "tag-a"
  | "tag-l"
  | "strip-marker"
  | "upper"
  | "lower"
  | "trim"
  | "collapse-blank"
  | "smart-quotes"

export interface TransformDef {
  id: TransformId
  label: string
  hint: string
}

export const TRANSFORMS: TransformDef[] = [
  { id: "bold", label: "加粗", hint: "包成 **文字**" },
  { id: "italic", label: "斜体", hint: "包成 *文字*" },
  { id: "code", label: "行内代码", hint: "包成 `文字`" },
  { id: "highlight", label: "高亮", hint: "包成 ==文字==" },
  { id: "wiki", label: "双链", hint: "包成 [[文字]]" },
  { id: "tag-d", label: "包为 #d 描述", hint: "段首加 #d" },
  { id: "tag-s", label: "包为 #s 场景", hint: "段首加 #s" },
  { id: "tag-a", label: "包为 #a 动作", hint: "段首加 #a" },
  { id: "tag-l", label: "包为 #l 对白", hint: "段首加 #l" },
  { id: "strip-marker", label: "去掉段首标签", hint: "移除 #d / #s / /s 等" },
  { id: "upper", label: "转大写", hint: "仅影响英文" },
  { id: "lower", label: "转小写", hint: "仅影响英文" },
  { id: "trim", label: "清理首尾空白", hint: "整体 trim" },
  { id: "collapse-blank", label: "压缩空行", hint: "连续空行压成一行" },
  { id: "smart-quotes", label: "智能引号", hint: "直引号 → 中文弯引号" },
]

const MARKER_PREFIX = /^(\s*)(?:#(?:d|e|v|t|c|s|a|r|l|p|x)|\/[sarxlp])\s+/

function smartQuotes(text: string): string {
  let doubleOpen = true
  let singleOpen = true
  return text
    .replace(/"/g, () => {
      const ch = doubleOpen ? "“" : "”"
      doubleOpen = !doubleOpen
      return ch
    })
    .replace(/'/g, () => {
      const ch = singleOpen ? "‘" : "’"
      singleOpen = !singleOpen
      return ch
    })
}

export function applyTransform(id: TransformId, input: string): string {
  const text = input
  switch (id) {
    case "bold":
      return `**${text}**`
    case "italic":
      return `*${text}*`
    case "code":
      return `\`${text}\``
    case "highlight":
      return `==${text}==`
    case "wiki":
      return `[[${text}]]`
    case "tag-d":
      return `#d ${text}`
    case "tag-s":
      return `#s ${text}`
    case "tag-a":
      return `#a ${text}`
    case "tag-l":
      return `#l ${text}`
    case "strip-marker":
      return text.replace(MARKER_PREFIX, "$1")
    case "upper":
      return text.toUpperCase()
    case "lower":
      return text.toLowerCase()
    case "trim":
      return text.trim()
    case "collapse-blank":
      return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    case "smart-quotes":
      return smartQuotes(text)
    default:
      return text
  }
}
