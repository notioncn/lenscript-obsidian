/**
 * 快捷输入词典（纯逻辑）
 *
 * 内置剧本模板 + 用户自定义条目，按「分组 → 分类 → 条目」三级组织，
 * 供 Alt+A 面板与多级菜单使用。不依赖 Obsidian，可直接 Node 单测。
 */

import { scriptTemplates } from "../templates/scriptTemplates"

export type DictionarySource = "builtin" | "custom"

export interface DictionaryCategory {
  /** 分类 id；自定义分类形如 custom:xxx */
  id: string
  label: string
  source: DictionarySource
}

export interface DictionaryGroup {
  id: string
  label: string
  categories: DictionaryCategory[]
}

export interface DictionaryEntry {
  id: string
  title: string
  hint?: string
  content: string
  category: string
  source: DictionarySource
}

export interface CustomDictionaryEntry {
  id: string
  title: string
  hint: string
  content: string
  category: string
  enabled: boolean
}

export interface DictionaryMenu {
  entries: DictionaryEntry[]
  groups: DictionaryGroup[]
}

/** 内置分类的中文名 */
const BUILTIN_CATEGORY_LABELS: Record<string, string> = {
  structure: "剧本结构",
  modevol: "语义标签",
  script: "剧本段落",
  prompt: "画面提示词",
  actor: "角色卡",
  scene: "场景卡",
}

/** 三级菜单的前两层：分组 → 内置分类 */
export const BUILTIN_GROUPS: DictionaryGroup[] = [
  {
    id: "writing",
    label: "写作辅助",
    categories: [
      { id: "structure", label: "剧本结构", source: "builtin" },
      { id: "modevol", label: "语义标签", source: "builtin" },
      { id: "script", label: "剧本段落", source: "builtin" },
    ],
  },
  {
    id: "ai",
    label: "AI 制作",
    categories: [
      { id: "prompt", label: "画面提示词", source: "builtin" },
      { id: "actor", label: "角色卡", source: "builtin" },
      { id: "scene", label: "场景卡", source: "builtin" },
    ],
  },
]

export function builtinCategoryLabel(category: string): string {
  return BUILTIN_CATEGORY_LABELS[category] ?? category
}

/** 清洗用户保存的自定义词典，坏数据直接丢弃 */
export function normalizeCustomDictionary(input: unknown): CustomDictionaryEntry[] {
  if (!Array.isArray(input)) return []
  const out: CustomDictionaryEntry[] = []
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return
    const item = raw as Record<string, unknown>
    const title = String(item.title ?? "").trim()
    const content = String(item.content ?? "")
    if (!title || !content.trim()) return
    out.push({
      id: String(item.id ?? "").trim() || `custom-${index + 1}`,
      title,
      hint: String(item.hint ?? "").trim(),
      content,
      category: String(item.category ?? "").trim() || "通用",
      enabled: item.enabled !== false,
    })
  })
  return out
}

/** 自定义条目的分类列表（去重，保持出现顺序） */
export function customCategoryLabels(custom: CustomDictionaryEntry[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of custom) {
    const label = entry.category || "通用"
    if (seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

/**
 * 合并内置与自定义条目。
 * 分类 id：内置直接用模板 category；自定义用 `custom:<分类名>`。
 */
export function buildDictionary(custom: CustomDictionaryEntry[]): DictionaryMenu {
  const entries: DictionaryEntry[] = scriptTemplates.map((tpl) => ({
    id: `builtin:${tpl.id}`,
    title: tpl.title,
    hint: tpl.hint,
    content: tpl.content,
    category: tpl.category,
    source: "builtin",
  }))

  const customEntries: DictionaryEntry[] = []
  const groups = BUILTIN_GROUPS.map((group) => ({
    ...group,
    categories: group.categories.map((c) => ({ ...c })),
  }))

  const labels = customCategoryLabels(custom.filter((entry) => entry.enabled))
  for (const entry of custom) {
    if (!entry.enabled) continue
    const categoryId = `custom:${entry.category || "通用"}`
    customEntries.push({
      id: `custom:${entry.id}`,
      title: entry.title,
      hint: entry.hint,
      content: entry.content,
      category: categoryId,
      source: "custom",
    })
  }

  if (customEntries.length) {
    groups.push({
      id: "custom",
      label: "自定义词典",
      categories: labels.map((label) => ({
        id: `custom:${label}`,
        label,
        source: "custom" as const,
      })),
    })
  }

  return { entries: [...entries, ...customEntries], groups }
}

/**
 * 插入文本。
 * 以空格结尾的条目视为「前缀型」（如 `#s `）：有选中文字时把选区接在后面；
 * 其余条目保持原样，由调用方插到光标处。
 */
export function insertionText(content: string, selection: string): string {
  if (selection && content.endsWith(" ")) return content + selection
  return content
}
