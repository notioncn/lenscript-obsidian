/**
 * 快捷输入面板（Alt+A）与选中文本转换面板
 *
 * 三级菜单：分组 → 分类 → 条目，右侧显示 Markdown 实时预览。
 * 词典数据来自 core/dictionary（内置剧本模板 + 用户自定义条目）。
 */

import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Setting,
} from "obsidian"
import {
  buildDictionary,
  customCategoryLabels,
  insertionText,
  type CustomDictionaryEntry,
  type DictionaryEntry,
  type DictionaryMenu,
} from "../core/dictionary"
import { applyTransform, TRANSFORMS, type TransformId } from "../core/transform"

function editorView(app: App): MarkdownView | null {
  return app.workspace.getActiveViewOfType(MarkdownView)
}

function insertEntry(app: App, entry: DictionaryEntry): boolean {
  const view = editorView(app)
  if (!view) {
    new Notice("请先打开一个 Markdown 笔记")
    return false
  }
  const editor = view.editor
  const selection = editor.getSelection()
  let content = entry.content

  if (selection && entry.content.endsWith(" ")) {
    content = insertionText(content, selection)
    editor.replaceSelection(content)
  } else {
    // 块状模板不吞掉选区：把光标放到选区末尾再插入
    if (selection) editor.setCursor(editor.getCursor("to"))
    editor.replaceSelection(content)
  }
  return true
}

export class DictionaryPanelModal extends Modal {
  private dictionary: DictionaryMenu
  private groupId = ""
  private categoryId = ""
  private selectedId: string | null = null
  private query = ""
  private visible: DictionaryEntry[] = []

  private listEl!: HTMLElement
  private catEl!: HTMLElement
  private groupEl!: HTMLElement
  private previewEl!: HTMLElement
  private statusEl!: HTMLElement
  private searchEl!: HTMLInputElement

  constructor(app: App, private readonly custom: CustomDictionaryEntry[]) {
    super(app)
    this.dictionary = buildDictionary(custom)
    const first = this.dictionary.groups[0]
    this.groupId = first?.id ?? ""
    this.categoryId = first?.categories[0]?.id ?? ""
  }

  onOpen(): void {
    this.titleEl.setText("镜语 · 快捷输入")
    this.modalEl.addClass("ls-dict-modal")

    const searchRow = this.contentEl.createDiv({ cls: "ls-dict-search-row" })
    this.searchEl = searchRow.createEl("input", {
      type: "text",
      placeholder: "搜索模板 / 词典条目…",
      cls: "ls-dict-search",
    })
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim()
      this.renderItems()
    })
    this.searchEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        this.moveSelection(e.key === "ArrowDown" ? 1 : -1)
      } else if (e.key === "Enter") {
        e.preventDefault()
        this.insertSelected()
      }
    })

    const body = this.contentEl.createDiv({ cls: "ls-dict-body" })
    this.groupEl = body.createDiv({ cls: "ls-dict-col ls-dict-groups" })
    this.catEl = body.createDiv({ cls: "ls-dict-col ls-dict-cats" })
    this.listEl = body.createDiv({ cls: "ls-dict-col ls-dict-items" })
    this.previewEl = body.createDiv({ cls: "ls-dict-col ls-dict-preview" })

    const footer = this.contentEl.createDiv({ cls: "ls-dict-footer" })
    this.statusEl = footer.createDiv({ cls: "ls-dict-status" })
    const insertBtn = footer.createEl("button", { text: "插入到当前笔记", cls: "mod-cta" })
    insertBtn.onclick = () => this.insertSelected()

    this.renderGroups()
    this.renderCategories()
    this.renderItems()
    this.renderTransforms(footer)

    window.setTimeout(() => this.searchEl.focus(), 50)
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private entriesOfCategory(): DictionaryEntry[] {
    const matchedCategory = this.dictionary.groups
      .flatMap((g) => g.categories)
      .some((c) => c.id === this.categoryId)
    return this.dictionary.entries.filter((entry) =>
      this.query ? true : matchedCategory ? entry.category === this.categoryId : true,
    )
  }

  private renderGroups(): void {
    this.groupEl.empty()
    for (const group of this.dictionary.groups) {
      const btn = this.groupEl.createEl("button", {
        text: group.label,
        cls: `ls-dict-entry${group.id === this.groupId ? " is-active" : ""}`,
      })
      btn.onclick = () => {
        this.groupId = group.id
        this.categoryId = group.categories[0]?.id ?? ""
        this.query = ""
        this.searchEl.value = ""
        this.renderGroups()
        this.renderCategories()
        this.renderItems()
      }
    }
  }

  private renderCategories(): void {
    this.catEl.empty()
    const group = this.dictionary.groups.find((g) => g.id === this.groupId)
    if (!group) return
    for (const category of group.categories) {
      const btn = this.catEl.createEl("button", {
        text: category.label,
        cls: `ls-dict-entry${category.id === this.categoryId ? " is-active" : ""}`,
      })
      btn.onclick = () => {
        this.categoryId = category.id
        this.query = ""
        this.searchEl.value = ""
        this.renderCategories()
        this.renderItems()
      }
    }
  }

  private renderItems(): void {
    this.listEl.empty()
    const all = this.dictionary.entries
    const filtered = this.query
      ? all.filter((entry) =>
          `${entry.title} ${entry.hint ?? ""} ${entry.content} ${entry.category}`
            .toLowerCase()
            .includes(this.query.toLowerCase()),
        )
      : this.entriesOfCategory()

    this.visible = filtered
    if (!filtered.some((entry) => entry.id === this.selectedId)) {
      this.selectedId = filtered[0]?.id ?? null
    }

    if (!filtered.length) {
      this.listEl.createDiv({ cls: "ls-dict-empty", text: "没有匹配的条目" })
    }

    for (const entry of filtered) {
      const item = this.listEl.createDiv({
        cls: `ls-dict-item${entry.id === this.selectedId ? " is-active" : ""}`,
      })
      item.createDiv({ cls: "ls-dict-item-title", text: entry.title })
      if (entry.hint) item.createDiv({ cls: "ls-dict-item-hint", text: entry.hint })
      const badge = item.createSpan({
        cls: `ls-dict-source${entry.source === "custom" ? " is-custom" : ""}`,
        text: entry.source === "custom" ? "自定义" : "内置",
      })
      badge.title = entry.category
      item.onclick = () => {
        this.selectedId = entry.id
        this.renderItems()
      }
      item.ondblclick = () => {
        this.selectedId = entry.id
        this.insertSelected()
      }
    }

    this.renderPreview()
    this.statusEl.setText(
      filtered.length
        ? `${filtered.length} 个条目 · 双击直接插入`
        : "试试左上角搜索",
    )
  }

  private renderPreview(): void {
    this.previewEl.empty()
    const entry = this.dictionary.entries.find((e) => e.id === this.selectedId)
    if (!entry) {
      this.previewEl.createDiv({ cls: "ls-dict-empty", text: "选择左侧条目查看预览" })
      return
    }
    this.previewEl.createDiv({ cls: "ls-dict-preview-title", text: entry.title })
    const previewBody = this.previewEl.createDiv({ cls: "ls-dict-preview-body" })
    const source = editorView(this.app)?.file?.path ?? ""
    const host = new Component()
    MarkdownRenderer.render(this.app, entry.content, previewBody, source, host).catch(() => {
      previewBody.setText(entry.content)
    })
  }

  private moveSelection(delta: number): void {
    if (!this.visible.length) return
    const index = this.visible.findIndex((e) => e.id === this.selectedId)
    const next = Math.max(0, Math.min(this.visible.length - 1, index + delta))
    this.selectedId = this.visible[next].id
    this.renderItems()
  }

  private insertSelected(): void {
    const entry = this.dictionary.entries.find((e) => e.id === this.selectedId)
    if (!entry) return
    if (insertEntry(this.app, entry)) this.close()
  }

  private renderTransforms(parent: HTMLElement): void {
    const view = editorView(this.app)
    const selection = view?.editor.getSelection() ?? ""
    if (!selection.trim()) return

    const row = parent.createDiv({ cls: "ls-dict-transforms" })
    row.createDiv({ cls: "ls-dict-transform-label", text: `选中 ${selection.length} 字 →` })
    for (const t of TRANSFORMS.slice(0, 8)) {
      const btn = row.createEl("button", { text: t.label, cls: "ls-dict-transform" })
      btn.title = t.hint
      btn.onclick = () => applyAndClose(this.app, t.id, selection)
    }
  }
}

function applyAndClose(app: App, id: TransformId, selection: string): void {
  const view = editorView(app)
  if (!view) {
    new Notice("请先打开一个 Markdown 笔记")
    return
  }
  view.editor.replaceSelection(applyTransform(id, selection))
}

export class TransformPickerModal extends Modal {
  private selection = ""

  onOpen(): void {
    this.titleEl.setText("转换 · 选中文本")
    this.modalEl.addClass("ls-transform-modal")
    this.selection = editorView(this.app)?.editor.getSelection() ?? ""

    if (!this.selection.trim()) {
      this.contentEl.createDiv({
        cls: "ls-dict-empty",
        text: "请先在笔记里选中一段文字，再执行这个命令。",
      })
      return
    }

    this.contentEl.createDiv({
      cls: "ls-dict-status",
      text: `已选中 ${this.selection.length} 字`,
    })

    const list = this.contentEl.createDiv({ cls: "ls-transform-list" })
    for (const t of TRANSFORMS) {
      const row = list.createDiv({ cls: "ls-transform-item" })
      row.createDiv({ cls: "ls-transform-name", text: t.label })
      row.createDiv({ cls: "ls-transform-hint", text: t.hint })
      row.onclick = () => {
        applyAndClose(this.app, t.id, this.selection)
        this.close()
      }
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** 设置页里新增 / 编辑一条自定义词典 */
export class DictionaryEntryModal extends Modal {
  private title: string
  private hint: string
  private content: string
  private category: string
  private enabled: boolean

  constructor(
    app: App,
    private readonly existing: CustomDictionaryEntry | null,
    private readonly onSave: (entry: CustomDictionaryEntry) => void,
  ) {
    super(app)
    this.title = existing?.title ?? ""
    this.hint = existing?.hint ?? ""
    this.content = existing?.content ?? ""
    this.category = existing?.category ?? "通用"
    this.enabled = existing?.enabled ?? true
  }

  onOpen(): void {
    this.titleEl.setText(this.existing ? "编辑自定义词典" : "添加自定义词典")
    this.modalEl.addClass("ls-dict-editor-modal")

    new Setting(this.contentEl)
      .setName("名称")
      .setDesc("显示在快捷输入面板里的标题")
      .addText((text) =>
        text.setPlaceholder("例如：镜头提示词").setValue(this.title).onChange((v) => {
          this.title = v
        }),
      )

    new Setting(this.contentEl)
      .setName("分类")
      .setDesc("自定义分类，例如「我的模板」「常用句式」")
      .addText((text) =>
        text
          .setPlaceholder("通用")
          .setValue(this.category)
          .onChange((v) => {
            this.category = v
          }),
      )

    new Setting(this.contentEl)
      .setName("提示")
      .setDesc("可选，显示在标题下面的一行说明")
      .addText((text) =>
        text.setValue(this.hint).onChange((v) => {
          this.hint = v
        }),
      )

    new Setting(this.contentEl)
      .setName("内容")
      .setDesc("插入笔记的 Markdown 原文；以空格结尾的条目会把选中文字接在后面")
      .addTextArea((area) => {
        area.inputEl.rows = 8
        area.inputEl.style.width = "100%"
        area.setValue(this.content).onChange((v) => {
          this.content = v
        })
      })

    const existingCategories = customCategoryLabels(
      this.existing ? [this.existing] : [],
    )
    if (existingCategories.length) {
      this.contentEl.createDiv({
        cls: "ls-dict-editor-tip",
        text: `已有自定义分类：${existingCategories.join("、")}`,
      })
    }

    const row = this.contentEl.createDiv({ cls: "ls-dict-editor-actions" })
    const cancel = row.createEl("button", { text: "取消" })
    cancel.onclick = () => this.close()
    const save = row.createEl("button", { text: "保存", cls: "mod-cta" })
    save.onclick = () => this.save()
  }

  private save(): void {
    if (!this.title.trim()) {
      new Notice("名称不能为空")
      return
    }
    if (!this.content.trim()) {
      new Notice("内容不能为空")
      return
    }
    this.onSave({
      id: this.existing?.id ?? `custom-${Date.now().toString(36)}`,
      title: this.title.trim(),
      hint: this.hint.trim(),
      content: this.content,
      category: this.category.trim() || "通用",
      enabled: this.enabled,
    })
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
