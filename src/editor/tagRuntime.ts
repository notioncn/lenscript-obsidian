/**
 * 标签配置运行时：编辑器装饰器与阅读视图共用一个可切换的标签索引。
 */

import { StateEffect } from "@codemirror/state"
import {
  DEFAULT_TAG_SETTINGS,
  resolveTags,
  setActiveTags,
  type ResolvedTag,
  type TagSettings,
} from "../core/tags"

let currentTags: ResolvedTag[] = resolveTags(DEFAULT_TAG_SETTINGS)
let currentVersion = 0
setActiveTags(currentTags)

/** 设置变更时向 CodeMirror 发这个 effect，强制重算装饰 */
export const tagConfigEffect = StateEffect.define<number>()

export function setTagConfig(settings: TagSettings): void {
  currentTags = resolveTags(settings)
  setActiveTags(currentTags)
  currentVersion++
}

export function getTags(): ResolvedTag[] {
  return currentTags
}

export function getTagVersion(): number {
  return currentVersion
}
