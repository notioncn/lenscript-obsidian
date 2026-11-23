/**
 * any-menu 风格本地模板字典
 * 剧本专用的快速输入模板：角色卡、场景卡、镜头描述、AI 提示词
 */

export interface ScriptTemplate {
  id: string
  title: string
  hint?: string
  content: string
  category: "structure" | "modevol" | "script" | "prompt" | "actor" | "scene"
}

export const scriptTemplates: ScriptTemplate[] = [
  // === 剧本结构 ===
  {
    id: "scene-block",
    title: "场景块",
    hint: "#s 新建一个场景",
    category: "structure",
    content: `
## #s 场景名称
#d 地点、时间、氛围描述。
`,
  },
  {
    id: "role-block",
    title: "角色块",
    hint: "#r 引入角色",
    category: "structure",
    content: `
### #r 角色名
#e 年龄、外貌、性格、当前状态。
`,
  },
  {
    id: "dialogue-block",
    title: "对白块",
    hint: "#l 角色台词",
    category: "structure",
    content: `
#### #l
#v （说话内容）
`,
  },
  {
    id: "cut-block",
    title: "转场",
    hint: "#x 切换场景",
    category: "structure",
    content: `
## #x 切
`,
  },

  // === Modevol 语义 ===
  {
    id: "modevol-d",
    title: "描述 #d",
    hint: "#d 用自己的语言说明",
    category: "modevol",
    content: "#d ",
  },
  {
    id: "modevol-e",
    title: "例子 #e",
    hint: "#e 落到具体情境",
    category: "modevol",
    content: "#e ",
  },
  {
    id: "modevol-v",
    title: "验证 #v",
    hint: "#v 安排可观察检查",
    category: "modevol",
    content: "#v ",
  },
  {
    id: "modevol-t",
    title: "迁移 #t",
    hint: "#t 追问离开原情境后",
    category: "modevol",
    content: "#t ",
  },
  {
    id: "modevol-c",
    title: "自定义说明 #c",
    hint: "#c 团队约定/编者注",
    category: "modevol",
    content: "#c ",
  },

  // === 剧本段落 ===
  {
    id: "script-s",
    title: "场景 #s",
    hint: "#s scene",
    category: "script",
    content: "#s ",
  },
  {
    id: "script-a",
    title: "动作 #a",
    hint: "#a action",
    category: "script",
    content: "#a ",
  },
  {
    id: "script-r",
    title: "角色 #r",
    hint: "#r role",
    category: "script",
    content: "#r ",
  },
  {
    id: "script-l",
    title: "对白 #l",
    hint: "#l dialogue",
    category: "script",
    content: "#l ",
  },
  {
    id: "script-p",
    title: "括注 #p",
    hint: "#p parenthetical",
    category: "script",
    content: "#p ",
  },
  {
    id: "script-x",
    title: "转场 #x",
    hint: "#x cut",
    category: "script",
    content: "#x ",
  },

  // === AI 视频提示词模板 ===
  {
    id: "prompt-shot",
    title: "镜头描述模板",
    hint: "为 AI 视频生成准备",
    category: "prompt",
    content: `
# 镜头描述
- 景别：中景 / 近景 / 特写 / 远景
- 运镜：推 / 拉 / 摇 / 跟 / 固定
- 时长：~ 4s
- 光影：冷暖调 / 顶光 / 侧光 / 逆光
- 氛围：
- 视频提示词：
`,
  },
  {
    id: "prompt-character-card",
    title: "角色卡模板",
    hint: "用于 AI 角色一致性",
    category: "actor",
    content: `
# 角色：角色名

| 字段 | 值 |
|------|-----|
| 年龄 | |
| 性别 | |
| 外貌 | |
| 性格 | |
| 标志性物品 | |
| 角色照片路径 | |
`,
  },
  {
    id: "prompt-scene-card",
    title: "场景卡模板",
    hint: "用于 AI 场景一致性",
    category: "scene",
    content: `
# 场景：场景名

| 字段 | 值 |
|------|-----|
| 类型 | 内景 / 外景 |
| 时间 | 日 / 夜 / 黄昏 / 清晨 |
| 季节 | |
| 关键元素 | |
| 氛围 | |
| 场景参考图 | |
`,
  },
]

/** 构建标准剧本脚手架 */
export function buildScriptScaffold(projectTitle: string): string {
  return `---
tags: [script, film]
created: ${new Date().toISOString().slice(0, 10)}
canvas: scenes.canvas
---

# ${projectTitle}

> 项目概述、主题、风格基调。

## #s 第一场景
#d 地点、时间、整体氛围。

### #r 角色名
#e 年龄、外貌、性格。

#### #a （动作描述）
#v 可观察的行为细节。

#### #l
#t （对白内容及其推进作用）

## #x 切

## #s 第二场景
…
`
}
