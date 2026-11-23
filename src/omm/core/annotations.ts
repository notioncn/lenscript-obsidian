/**
 * 节点行尾的 `%%注解%%` 解析与写回。
 *
 * 行的数据源永远是 Markdown 本身：注解作为行尾的 Obsidian 注释存在，
 * `%%box=3 "第一幕"%%` 这样的标记既能被人读懂，也不会在阅读视图里渲染出来。
 *
 * 约定（与画布导图一致）：
 * - `%%box%%` / `%%box=3%%` / `%%box=3 "标题"%%`：框住本节点及其后 span-1 个兄弟
 * - `%%summary=3 "文字"%%`：本节点及其后 span-1 个兄弟的概要
 * - `%%callout "文字"%%`（可选 `cc=色`）：挂在节点上方的标注气泡
 * - `%%id=r1%%` / `%%rel=r1 "文字" c=0,-80%%`：关联线的端点与连线
 * - `%%float x=320 y=-80%%`：自由主题（相对父节点中心的偏移）
 *
 * 【禁止】import 任何 obsidian API。
 */

export interface SpanAnnotation {
  /** 覆盖的兄弟节点数量，至少 1（含起始节点自己）。 */
  span: number
  /** 括号 / 框上挂的文字，可为空。 */
  text: string
}

export interface CalloutAnnotation {
  text: string
  /** 颜色名或 #hex，空则用主题色。 */
  color?: string
}

export interface RelationAnnotation {
  /** 目标节点的 `%%id=…%%`。 */
  target: string
  text: string
  /** 贝塞尔控制点偏移，相对两端中点；缺省不限。 */
  curve?: [number, number]
  /** 双向关联（两端都画箭头）。缺省为单向：从本节点指向 target。 */
  both?: boolean
}

export interface FloatAnnotation {
  x: number
  y: number
}

export interface NodeAnnotations {
  box?: SpanAnnotation
  summary?: SpanAnnotation
  callout?: CalloutAnnotation
  /** 本节点的关联线锚点，别的节点用 `rel=` 指过来。 */
  anchor?: string
  /** 从本节点出发的关联线。 */
  rels: RelationAnnotation[]
  float?: FloatAnnotation
}

/** 行尾「一个注解 + 分隔空白」的匹配。`%%` 之间不允许再出现 `%%`。 */
const TRAILING_RE = /^([\s\S]*?)([ \t]*)%%((?:[^%]|%(?!%))*?)%%[ \t]*$/

const BOX_RE = /^box(?:=(\d+))?(?:[ \t]+"([\s\S]*)")?$/
const SUMMARY_RE = /^summary(?:=(\d+))?(?:[ \t]+"([\s\S]*)")?$/
const CALLOUT_RE = /^callout[ \t]+"([\s\S]*)"(?:[ \t]+cc=(\S+))?$/
const ANCHOR_RE = /^id=([A-Za-z0-9_-]+)$/
const REL_RE = /^rel=([A-Za-z0-9_-]+)(?:[ \t]+"([\s\S]*?)")?(?:[ \t]+(both))?(?:[ \t]+c=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?$/
const FLOAT_RE = /^float(?:[ \t]+x=(-?\d+(?:\.\d+)?))?(?:[ \t]+y=(-?\d+(?:\.\d+)?))?$/

function spanCount(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

/**
 * 把一个 `%%…%%` 里的内容解析成注解字段；不是已知注解返回 null。
 *
 * 返回 null 时调用方【必须】把这段留在正文里——那可能是用户自己写的普通注释。
 */
function parseToken(token: string): Partial<NodeAnnotations> | null {
  const body = token.trim()
  if (body === '') return null

  let m = BOX_RE.exec(body)
  if (m) return { box: { span: spanCount(m[1]), text: m[2] ?? '' } }

  m = SUMMARY_RE.exec(body)
  if (m) return { summary: { span: spanCount(m[1]), text: m[2] ?? '' } }

  m = CALLOUT_RE.exec(body)
  if (m) return { callout: { text: m[1] ?? '', ...(m[2] ? { color: m[2] } : {}) } }

  m = ANCHOR_RE.exec(body)
  if (m) return { anchor: m[1] }

  m = REL_RE.exec(body)
  if (m) {
    return {
      rels: [{
        target: m[1] ?? '',
        text: m[2] ?? '',
        ...(m[3] === 'both' ? { both: true } : {}),
        ...(m[4] !== undefined && m[5] !== undefined
          ? { curve: [Number(m[4]), Number(m[5])] as [number, number] }
          : {}),
      }],
    }
  }

  m = FLOAT_RE.exec(body)
  if (m) return { float: { x: Number(m[1] ?? 0), y: Number(m[2] ?? 0) } }

  return null
}

/** 编辑器把注解标记渲染成小图标时用的种类。 */
export type AnnotationKind = 'box' | 'summary' | 'callout' | 'anchor' | 'rel' | 'float'

/**
 * 判断一个 `%%…%%` 里装的是不是【已知注解】，以及是哪一种。
 *
 * 编辑器装饰器只认已知注解：用户自己写的普通 `%%注释%%` 必须原样留在正文里，
 * 不能被替换成图标。
 */
export function annotationKind(token: string): AnnotationKind | null {
  const parsed = parseToken(token)
  if (!parsed) return null
  if (parsed.box) return 'box'
  if (parsed.summary) return 'summary'
  if (parsed.callout) return 'callout'
  if (parsed.anchor) return 'anchor'
  if (parsed.rels) return 'rel'
  if (parsed.float) return 'float'
  return null
}

export interface SplitResult {
  /** 去掉注解后的标题文字。 */
  text: string
  /** 解析出来的注解；一个都没有时为 null。 */
  annotations: NodeAnnotations | null
  /** 原样的 `%%…%%` 尾巴（含分隔空白）。改名 / 移动时原样接回行尾。 */
  raw: string
}

/**
 * 拆分行尾注解。只认已知关键字，未知的 `%%…%%` 一律留在文字里。
 */
export function splitAnnotations(line: string): SplitResult {
  let content = line
  const raws: string[] = []
  let current: NodeAnnotations | null = null

  for (;;) {
    const m = TRAILING_RE.exec(content)
    if (!m) break
    const parsed = parseToken(m[3] ?? '')
    if (!parsed) break
    raws.unshift((m[2] ?? '') + '%%' + (m[3] ?? '') + '%%')
    content = m[1] ?? ''
    current = mergeAnnotations(current, parsed)
  }

  return {
    text: content.replace(/[ \t]+$/, ''),
    annotations: current,
    raw: raws.join(''),
  }
}

/** 把一条注解并进已有的注解集合。`rels` 追加，其余后者覆盖前者。 */
function mergeAnnotations(into: NodeAnnotations | null, patch: Partial<NodeAnnotations>): NodeAnnotations {
  const base: NodeAnnotations = into ?? { rels: [] }
  if (!base.rels) base.rels = []
  if (patch.box) base.box = patch.box
  if (patch.summary) base.summary = patch.summary
  if (patch.callout) base.callout = patch.callout
  if (patch.anchor) base.anchor = patch.anchor
  if (patch.float) base.float = patch.float
  if (patch.rels) base.rels.push(...patch.rels)
  return base
}

/** 引号 / 换行会破坏 `%%…"…"%%` 的结构，写回前统一收敛掉。 */
function safe(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim()
}

/**
 * 注解 → 行尾 `%%…%%` 尾巴（含前导空格）。
 *
 * 与 `splitAnnotations` 互逆：只输出已知关键字，顺序固定为 框 → 概要 → 标注 → 锚点 → 关联线 → 自由主题。
 * 没有任何注解时返回空串。
 */
export function serializeAnnotations(annotations: NodeAnnotations | null | undefined): string {
  if (!annotations) return ''
  const parts: string[] = []
  if (annotations.box) {
    parts.push(`%%box=${annotations.box.span}${annotations.box.text ? ` "${safe(annotations.box.text)}"` : ''}%%`)
  }
  if (annotations.summary) {
    parts.push(`%%summary=${annotations.summary.span}${annotations.summary.text ? ` "${safe(annotations.summary.text)}"` : ''}%%`)
  }
  if (annotations.callout) {
    parts.push(`%%callout "${safe(annotations.callout.text)}"${annotations.callout.color ? ` cc=${annotations.callout.color}` : ''}%%`)
  }
  if (annotations.anchor) parts.push(`%%id=${annotations.anchor}%%`)
  for (const rel of annotations.rels ?? []) {
    parts.push(`%%rel=${rel.target}${rel.text ? ` "${safe(rel.text)}"` : ''}${rel.both ? ' both' : ''}${rel.curve ? ` c=${rel.curve[0]},${rel.curve[1]}` : ''}%%`)
  }
  if (annotations.float) parts.push(`%%float x=${annotations.float.x} y=${annotations.float.y}%%`)
  return parts.length ? ' ' + parts.join(' ') : ''
}

/** 节点是否有任何会被导图渲染出来的注解。 */
export function hasAnnotations(annotations: NodeAnnotations | null | undefined): boolean {
  if (!annotations) return false
  return Boolean(
    annotations.box ||
    annotations.summary ||
    annotations.callout ||
    annotations.float ||
    annotations.anchor ||
    (annotations.rels && annotations.rels.length > 0),
  )
}
