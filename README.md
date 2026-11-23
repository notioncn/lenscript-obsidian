# 镜语剧本编辑器 · Lenscript for Obsidian

把 Markdown 剧本、边缘大纲导轨、可编辑思维导图和白板放进同一个 Obsidian 插件里。
面向 AI 生视频 / 短片创作的写作流程：**正文就是数据源，导图和白板只是视图**，不需要在几套格式之间来回导出。

## 功能

- **剧本 Markdown 语义**：`#s` 场景、`#a` 动作、`#r` 角色、`#l` 对白、`#p` 括注、`#x` 转场，以及 `#d` 描述、`#e` 例子、`#v` 验证、`#t` 迁移、`#c 自定义说明`。
- **边缘大纲导轨**：在编辑器右侧常驻一条标题导轨，悬停预览、点击跳转，不占正文宽度。
- **可编辑思维导图**：直接读写 Markdown 标题树；支持折叠、拖拽重排、合并节点、外框、概要、气泡标注、关联线、锚点，以及把节点拖成「独立」自由节点。
- **自由画布**：导图可以平移缩放，独立节点可在画布上自由摆放。
- **嵌套白板**：兼容 `.nboard` 的无限白板，可嵌入内嵌脑图或 `.nestmind` 文件。
- **移动端可用**：iPad / 手机上的导图工具条、拖拽与文本编辑都做了适配。

## 安装

### 手动安装

1. 从 [Releases](../../releases) 下载 `main.js`、`manifest.json`、`styles.css`；
2. 放进 `你的库/.obsidian/plugins/lenscript/`；
3. 重启 Obsidian，在「设置 → 第三方插件」里启用 **镜语剧本编辑器**。

### BRAT（推荐，方便跟进更新）

1. 安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)；
2. BRAT → Add Beta Plugin → 填入本仓库地址；
3. 启用插件。

## 用法速览

- 打开一篇 Markdown 笔记，命令面板执行「镜语：打开导图」即可把当前笔记变成思维导图。
- 导图里的结构与文字都会写回 Markdown：标题层级就是父子关系，行尾的 `%%…%%` 是注解（外框 / 气泡 / 关联线 / 锚点 / 自由位置）。
- 行尾注解码（`%%callout "…"%%`、`%%id=r1%%`、`%%rel=r1%%` …）在编辑器里会显示成小图标，点一下图标即可展开原始文本编辑。

## 0.7.1 修复

- **iPad / 移动端工具条图标发白**：补上 `body.is-mobile` 作用域的颜色与 `appearance: none`，覆盖系统按钮外观和移动端主题对 `svg` 的直接着色。
- **独立节点不能自由拖拽**：带 `%%float%%` 的独立节点改为「位置拖拽」——拖动时实时平移、松手写回新的相对偏移，不再走结构重排、也不会被布局弹回原位；拖到画布空白处同样按落点自由摆放。
- **文本编辑页显示原始注解**：新增 CodeMirror 装饰器，把行尾的已知注解换成对应功能图标；光标进入标记时自动露出源码，普通 `%%注释%%` 不受影响。

## 开发

```bash
npm install
npm run dev     # watch
npm run build   # 生产构建 main.js
npm test        # 核心逻辑单测（node 原生 test runner）
```

构建产物 `main.js` + `manifest.json` + `styles.css` 即插件本体。

```
main.ts                插件入口：注册视图 / 命令 / 编辑器扩展
src/editor/            编辑器装饰与 Markdown 后处理
src/omm/core/          导图内核：解析、注解、树操作、布局
src/omm/view/          导图视图：画布、节点、拖拽、注解层
src/omm/doc/           导图与 Markdown 的桥接、编辑器图标
src/views/             大纲导轨 / 白板 / 嵌套脑图
test/                  内核单测
```

## 许可

[MIT](LICENSE) © 2026 fan1756
