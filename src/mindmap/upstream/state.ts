/** 仅保留画布需要的备注卡状态类型（不使用上游的 localStorage/state.json 实现） */
export interface NoteCardState {
  collapsed?: boolean
  w?: number
  h?: number
}
export type NoteCards = Record<string, NoteCardState>
