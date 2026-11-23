/**
 * 导图主题预设。
 *
 * 画布版导图有整套主题（雪白、彩虹、商务、暖阳、森林…），统一导图只有配色参数。
 * 这里把常用的那几套固化成「一键切换」的预设：只覆盖配色 / 连线 / 字形 / 分级着色，
 * 间距、字号这些用户已经调过的值保持不动。
 */

import type { MindmapStyle } from './StyleStore'
import type { MsgKey } from '../i18n'

export interface ThemePreset {
  id: string
  /** i18n key；显示名在 i18n.ts 里维护，中英各一份。 */
  labelKey: MsgKey
  style: Partial<MindmapStyle>
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'default',
    labelKey: 'theme.default',
    style: {
      scheme: 'theme',
      shape: 'rounded',
      branch: 'elbow',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'yuanji',
    labelKey: 'theme.yuanji',
    style: {
      scheme: 'yuanji',
      shape: 'rounded',
      branch: 'curve',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'blue',
    labelKey: 'theme.blue',
    style: {
      scheme: 'blue',
      shape: 'rounded',
      branch: 'elbow',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'forest',
    labelKey: 'theme.forest',
    style: {
      scheme: 'green',
      shape: 'rounded',
      branch: 'elbow',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'sunset',
    labelKey: 'theme.sunset',
    style: {
      scheme: 'warm',
      shape: 'rounded',
      branch: 'curve',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'rainbow',
    labelKey: 'theme.rainbow',
    style: {
      scheme: 'theme',
      shape: 'rounded',
      branch: 'curve',
      colorByLevel: true,
      levelColors: ['#4a8ef0', '#35c6d4', '#3aa675', '#e0a03c', '#d96f8c', '#8b7bd8'],
      background: '',
      edgeColor: '',
    },
  },
  {
    id: 'mono',
    labelKey: 'theme.mono',
    style: {
      scheme: 'mono',
      shape: 'underline',
      branch: 'straight',
      colorByLevel: false,
      levelColors: [],
      background: '',
      edgeColor: '',
    },
  },
]

/** 当前样式像不像这个预设：只比配色相关的几项，间距/字号不影响判断。 */
export function matchesPreset(style: MindmapStyle, preset: ThemePreset): boolean {
  const target = preset.style
  if (target.scheme !== undefined && style.scheme !== target.scheme) return false
  if (target.colorByLevel !== undefined && style.colorByLevel !== target.colorByLevel) return false
  if (target.shape !== undefined && style.shape !== target.shape) return false
  if (target.branch !== undefined && style.branch !== target.branch) return false
  const colors = target.levelColors ?? []
  if (colors.length > 0) {
    const current = style.levelColors ?? []
    if (colors.some((color, index) => (current[index] ?? '') !== color)) return false
  }
  return true
}
