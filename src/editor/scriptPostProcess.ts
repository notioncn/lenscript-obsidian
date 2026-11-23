/**
 * Markdown 后处理器
 * Reading view 中把 #d / #e / #s 等段首标签替换成“描述 / 例子 / 场景”等文字徽章。
 * 标签来源与编辑器共用 tagRuntime，支持自定义标签与组开关。
 */

import { getTags } from "./tagRuntime"
import {
  matchTagAtLine,
  type MatchedTag,
  type ResolvedTag,
} from "../core/tags"

interface WalkState {
  /** 当前位置是否处于一行的开头（段落起点或 <br> 之后） */
  atLineStart: boolean
  found: boolean
  tag?: ResolvedTag
}

function makeBadge(matched: MatchedTag): HTMLElement {
  const tag = matched.tag
  const badge = document.createElement("span")
  badge.className = `ls-marker ls-marker-type ${tag.badgeClass}`
  badge.style.background = tag.color
  badge.style.color = "#fff"
  badge.textContent = tag.label
  badge.title = `${tag.label}（${matched.marker}）`
  return badge
}

function replaceInTextNode(node: Text, offset: number, matched: MatchedTag): void {
  const raw = node.textContent || ""
  const before = raw.slice(0, offset)
  const after = raw.slice(offset + matched.marker.length)
  const parent = node.parentNode
  if (!parent) return
  if (before) parent.insertBefore(document.createTextNode(before), node)
  parent.insertBefore(makeBadge(matched), node)
  node.textContent = after.startsWith(" ") ? after.slice(1) : after
}

function replaceElement(node: Node, matched: MatchedTag): void {
  const badge = makeBadge(matched)
  const parent = node.parentNode
  if (parent) parent.replaceChild(badge, node)
  const next = badge.nextSibling
  if (
    next &&
    next.nodeType === Node.TEXT_NODE &&
    (next.textContent || "").startsWith(" ")
  ) {
    next.textContent = (next.textContent || "").slice(1)
  }
}

function walk(node: Node, state: WalkState, tags: ResolvedTag[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ""
    if (state.atLineStart) {
      const lead = text.length - text.trimStart().length
      const matched = matchTagAtLine(text.slice(lead), tags)
      if (matched) {
        state.found = true
        if (!state.tag) state.tag = matched.tag
        replaceInTextNode(node as Text, lead, matched)
        state.atLineStart = false
        return
      }
    }
    if (text.trim()) state.atLineStart = false
    return
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  if (el.tagName === "BR") {
    state.atLineStart = true
    return
  }

  // Obsidian 会把 #s 渲染成独立的标签链接元素，整体替换为徽章
  if (state.atLineStart) {
    const content = el.textContent || ""
    const matched = matchTagAtLine(content, tags)
    if (matched && content === matched.marker) {
      state.found = true
      state.tag = matched.tag
      replaceElement(el, matched)
      state.atLineStart = false
      return
    }
  }

  for (const child of Array.from(el.childNodes)) {
    walk(child, state, tags)
  }
}

export function scriptPostProcessor(html: HTMLElement): void {
  const tags = getTags()
  const elements = html.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li")

  elements.forEach((el) => {
    const state: WalkState = { atLineStart: true, found: false }
    for (const child of Array.from(el.childNodes)) {
      walk(child, state, tags)
    }
    if (!state.found || !state.tag) return

    el.classList.add(state.tag.blockClass, "ls-block-tag")
    ;(el as HTMLElement).style.setProperty("--ls-tag-color", state.tag.color)
  })
}
