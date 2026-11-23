/**
 * 剧本语义类型系统
 * 源自景启 AI (modevol-editor) 的五类 Modevol + 六类剧本段落
 */

// === 五类 Modevol 语义标签 ===
export const MODEVOL_TYPES = ['d', 'e', 'v', 't', 'c'] as const
export type ModevolType = (typeof MODEVOL_TYPES)[number]

export const MODEVOL_LABELS: Record<ModevolType, string> = {
  d: '描述',
  e: '例子',
  v: '验证',
  t: '迁移',
  c: '自定义说明',
}

export const MODEVOL_COLORS: Record<ModevolType, string> = {
  d: '#2F6FAF',
  e: '#C0504D',
  v: '#5572F1',
  t: '#9C7A00',
  c: '#7F7F7F',
}

export const MODEVOL_MARKER_REGEX = /^#([devtc])\s+/

// === 六类剧本段落 ===
export const SCRIPT_TYPES = ['s', 'a', 'r', 'l', 'p', 'x'] as const
export type ScriptType = (typeof SCRIPT_TYPES)[number]

export const SCRIPT_LABELS: Record<ScriptType, string> = {
  s: '场景',
  a: '动作',
  r: '角色',
  l: '对白',
  p: '括注',
  x: '转场',
}

export const SCRIPT_COLORS: Record<ScriptType, string> = {
  s: '#3A7D44',
  a: '#6B5B95',
  r: '#A05A2C',
  l: '#2F6FAF',
  p: '#7F7F7F',
  x: '#A33F62',
}

/** 剧本段落统一用 # 前缀；旧文档的 /s 等写法继续兼容 */
export const SCRIPT_MARKER_REGEX = /^(?:#|\/)([sarxlp])\s+/

// === 联合类型 ===
export type ScriptMarkerType = ModevolType | ScriptType

export function isModevolType(t: string): t is ModevolType {
  return (MODEVOL_TYPES as readonly string[]).includes(t)
}

export function isScriptType(t: string): t is ScriptType {
  return (SCRIPT_TYPES as readonly string[]).includes(t)
}

export function parseLineMarker(line: string): { type: ScriptMarkerType; label: string; textOffset: number } | null {
  // 先检查 Modevol 标记（#d #e #v #t #c）
  const mMatch = line.match(MODEVOL_MARKER_REGEX)
  if (mMatch) {
    const t = mMatch[1] as ModevolType
    return { type: t, label: MODEVOL_LABELS[t], textOffset: mMatch[0].length }
  }
  // 再检查剧本标记（#s #a #r #l #p #x，兼容旧写法 /s 等）
  const sMatch = line.match(SCRIPT_MARKER_REGEX)
  if (sMatch) {
    const t = sMatch[1] as ScriptType
    return { type: t, label: SCRIPT_LABELS[t], textOffset: sMatch[0].length }
  }
  return null
}
