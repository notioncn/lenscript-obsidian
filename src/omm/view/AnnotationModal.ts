/**
 * 标注编辑弹窗：概要 / 外框 / 标注气泡共用。
 *
 * 只收集「文字 + 覆盖节点数」，真正的写回交给 `setNodeAnnotations`。
 */

import { App, Modal, Setting } from 'obsidian'
import { t } from '../i18n'

export interface AnnotationForm {
  title: string
  /** 初始文字。 */
  text: string
  /** 初始覆盖节点数（仅概要 / 外框用）。 */
  span: number
  /** 是否显示「覆盖节点数」。标注气泡不需要。 */
  withSpan: boolean
  onConfirm: (result: { text: string; span: number }) => void
}

export class AnnotationModal extends Modal {
  constructor(
    app: App,
    private readonly form: AnnotationForm,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: this.form.title })

    let text = this.form.text
    let span = this.form.span

    new Setting(contentEl)
      .setName(t('anno.text'))
      .setDesc(t('anno.textDesc'))
      .addTextArea((area) => {
        area.setValue(text).onChange((value) => {
          text = value
        })
        area.inputEl.rows = 2
        window.setTimeout(() => area.inputEl.focus(), 0)
      })

    if (this.form.withSpan) {
      new Setting(contentEl)
        .setName(t('anno.span'))
        .setDesc(t('anno.spanDesc'))
        .addText((input) => {
          input.setValue(String(span)).onChange((value) => {
            const parsed = Number.parseInt(value, 10)
            if (Number.isFinite(parsed) && parsed >= 1) span = parsed
          })
          input.inputEl.type = 'number'
          input.inputEl.min = '1'
          input.inputEl.max = '50'
        })
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('anno.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('anno.confirm'))
          .setCta()
          .onClick(() => {
            this.form.onConfirm({ text: text.trim(), span })
            this.close()
          }),
      )

    contentEl.createEl('p', { cls: 'om-anno-hint', text: t('anno.hint') })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
