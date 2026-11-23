/**
 * Markdown 任务复选框：`- [ ] 待办` / `- [x] 已完成`。
 *
 * 只解析标题开头的 `[ ] ` / `[x] `，其余部分原样返回。
 * 【禁止】import 任何 obsidian API。
 */

export interface TaskMark {
  checked: boolean
  /** 去掉复选框前缀后的文字。 */
  rest: string
}

const TASK_RE = /^\[( |x|X)\]\s+/

/** 标题是不是任务项；不是返回 null。 */
export function taskOf(text: string): TaskMark | null {
  const match = TASK_RE.exec(text)
  if (!match) return null
  return { checked: match[1] !== ' ', rest: text.slice(match[0].length) }
}

/** `[ ] …` ⇄ `[x] …`。不是任务项的返回原串。 */
export function toggleTaskText(text: string): string {
  const match = TASK_RE.exec(text)
  if (!match) return text
  const box = match[1] === ' ' ? '[x]' : '[ ]'
  return box + ' ' + text.slice(match[0].length)
}
