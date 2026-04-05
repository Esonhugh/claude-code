// Keybinding context names — each context defines a scope in which
// bindings are active (e.g. "Chat" vs "Global").
export type KeybindingContextName =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Confirmation'
  | 'Help'
  | 'Transcript'
  | 'HistorySearch'
  | 'Task'
  | 'ThemePicker'
  | 'Settings'
  | 'Tabs'
  | 'Attachments'
  | 'Footer'
  | 'MessageSelector'
  | 'DiffDialog'
  | 'ModelPicker'
  | 'Select'
  | 'Plugin'
  | (string & {})

// A keybinding action — either a known action string, a command reference,
// or null to unbind.
export type KeybindingAction = string | null

// A single parsed keystroke (e.g. ctrl+shift+k).
export interface ParsedKeystroke {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

// A chord is a sequence of keystrokes (e.g. ctrl+k followed by ctrl+s).
export type Chord = ParsedKeystroke[]

// A fully resolved binding: chord → action within a context.
export interface ParsedBinding {
  chord: Chord
  action: KeybindingAction
  context: KeybindingContextName
}

// A keybinding block as it appears in user config JSON.
export interface KeybindingBlock {
  context: KeybindingContextName
  bindings: Record<string, KeybindingAction>
}
