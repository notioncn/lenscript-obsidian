/**
 * 标签组系统（纯逻辑）
 *
 * 两组官方默认标签：
 *   - 语义标签 #d / #e / #v / #t / #c —— 用于拆分文章
 *   - 剧本段落 #s / #a / #r / #l / #p / #x —— 用于标注剧本（旧写法 /s 等仍兼容）
 *
 * 用户可新增自定义标签（如 #o），自定义显示文字与颜色，并单独开关。
 */

import {
  MODEVOL_COLORS,
  MODEVOL_LABELS,
  MODEVOL_TYPES,
  SCRIPT_COLORS,
  SCRIPT_LABELS,
  SCRIPT_TYPES,
  type ModevolType,
  type ScriptType,
} from "../script-types"

export interface CustomTagDef {
  marker: string
  label: string
  color: string
  enabled: boolean
}

export interface TagSettings {
  semanticEnabled: boolean
  scriptEnabled: boolean
  custom: CustomTagDef[]
}

export const DEFAULT_TAG_SETTINGS: TagSettings = {
  semanticEnabled: true,
  scriptEnabled: true,
  custom: [],
}

export type TagGroup = "semantic" | "script" | "custom"

export interface ResolvedTag {
  id: string
  group: TagGroup
  marker: string
  /** 兼容旧写法的别名，例如 /s 仍能识别为 #s */
  aliases?: string[]
  label: string
  color: string
  /** CodeMirror 行装饰类，例如 ls-block-d */
  blockClass: string
  /** 徽章类，例如 ls-type-d / ls-scene */
  badgeClass: string
}

const SCRIPT_CLASS: Record<ScriptType, string> = {
  s: "scene",
  a: "action",
  r: "role",
  l: "dialog",
  p: "paren",
  x: "cut",
}

const CUSTOM_PALETTE = [
  "#2F6FAF",
  "#C0504D",
  "#5572F1",
  "#3A7D44",
  "#6B5B95",
  "#A05A2C",
  "#A33F62",
  "#7F7F7F",
]

export function normalizeTagSettings(input: unknown): TagSettings {
  const raw = input && typeof input === "object" ? (input as any) : {}
  const custom: CustomTagDef[] = []
  if (Array.isArray(raw.custom)) {
    for (const item of raw.custom) {
      if (!item || typeof item !== "object") continue
      const marker = normalizeMarker(String(item.marker ?? ""))
      if (!marker) continue
      custom.push({
        marker,
        label: String(item.label ?? "").trim() || marker,
        color: typeof item.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(item.color)
          ? item.color
          : CUSTOM_PALETTE[custom.length % CUSTOM_PALETTE.length],
        enabled: item.enabled !== false,
      })
    }
  }
  return {
    semanticEnabled: raw.semanticEnabled !== false,
    scriptEnabled: raw.scriptEnabled !== false,
    custom,
  }
}

export function normalizeMarker(value: string): string {
  const marker = value.trim()
  return /^#[A-Za-z0-9_-]{1,12}$/.test(marker) ? marker : ""
}

export function validateCustomMarker(
  marker: string,
  settings: TagSettings,
  ignoreIndex = -1,
): string | null {
  const m = normalizeMarker(marker)
  if (!m) return "标签符号必须以 # 开头，后接 1-12 个字母、数字、下划线或连字符"
  const reserved = new Set<string>()
  for (const t of MODEVOL_TYPES) reserved.add(`#${t}`)
  for (const t of SCRIPT_TYPES) reserved.add(`#${t}`)
  if (reserved.has(m)) return `${m} 是官方默认标签，不能重复定义`
  const exists = settings.custom.some((c, i) => i !== ignoreIndex && c.marker === m)
  if (exists) return `${m} 已经存在`
  return null
}

export function resolveTags(settings: TagSettings): ResolvedTag[] {
  const tags: ResolvedTag[] = []

  if (settings.semanticEnabled) {
    for (const t of MODEVOL_TYPES) {
      const type = t as ModevolType
      tags.push({
        id: `semantic-${type}`,
        group: "semantic",
        marker: `#${type}`,
        label: MODEVOL_LABELS[type],
        color: MODEVOL_COLORS[type],
        blockClass: `ls-block-${type}`,
        badgeClass: `ls-marker-modevol ls-type-${type}`,
      })
    }
  }

  if (settings.scriptEnabled) {
    for (const t of SCRIPT_TYPES) {
      const type = t as ScriptType
      tags.push({
        id: `script-${type}`,
        group: "script",
        marker: `#${type}`,
        aliases: [`/${type}`],
        label: SCRIPT_LABELS[type],
        color: SCRIPT_COLORS[type],
        blockClass: `ls-block-${type}`,
        badgeClass: `ls-marker-script ls-${SCRIPT_CLASS[type]}`,
      })
    }
  }

  for (const c of settings.custom) {
    if (!c.enabled) continue
    const marker = normalizeMarker(c.marker)
    if (!marker) continue
    tags.push({
      id: `custom-${marker}`,
      group: "custom",
      marker,
      label: c.label || marker,
      color: c.color,
      blockClass: "ls-block-tag",
      badgeClass: "ls-marker-custom",
    })
  }

  // 长标记优先，避免 #abc 被 #ab 截断
  return tags.sort((a, b) => b.marker.length - a.marker.length)
}

let activeTags: ResolvedTag[] = resolveTags(DEFAULT_TAG_SETTINGS)

/** 运行时标签索引：供编辑器、阅读视图、块切分共用 */
export function setActiveTags(tags: ResolvedTag[]): void {
  activeTags = tags
}

export function getActiveTags(): ResolvedTag[] {
  return activeTags
}

export interface MatchedTag {
  tag: ResolvedTag
  marker: string
}

/** 匹配行首标签；标签后必须是空白或行尾，避免把 #dear 当成 #d */
export function matchTagAtLine(line: string, tags: ResolvedTag[]): MatchedTag | null {
  for (const tag of tags) {
    const candidates = [tag.marker, ...(tag.aliases ?? [])]
    for (const marker of candidates) {
      if (!line.startsWith(marker)) continue
      const next = line[marker.length]
      if (next === undefined || /\s/.test(next)) {
        return { tag, marker }
      }
    }
  }
  return null
}
