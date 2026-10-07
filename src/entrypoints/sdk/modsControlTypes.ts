/** Plain wire data for the Mods UI control protocol (official 2.1.292). */
export type SDKUIRemoteSurface = 'desktop' | 'mobile' | 'vscode'
export type SDKUISurface = 'terminal' | SDKUIRemoteSurface
export type SDKUIViewport = {
  columns: number
  rows: number
  isFullscreen?: boolean
}
export type SDKUIAnswer =
  | 'ui_copy'
  | 'ui_prompt_read'
  | 'ui_prompt_fill'
  | 'ui_prompt_suggest'
  | 'ui_read_selection'
export type SDKUIRenderComponent =
  | 'AskUserQuestion'
  | 'UserMessage'
  | 'AssistantMessage'
  | 'ToolUse'
  | 'ToolResult'
  | 'ToolGroup'
  | 'ToolProgress'
  | 'CommandOutput'
  | 'Spinner'
  | 'TurnDuration'
  | 'InfoNotice'
  | 'SessionMode'
  | 'PromptHint'
  | 'AbovePrompt'
  | 'Pane'
export type SDKUIScrollComponent = 'Pane' | 'AbovePrompt'
export type SDKUIOnScreen = { first: number; last: number; of: number }
export type SDKUIKeyedRows = {
  plugin: string
  key: string
  top: number
  bottom: number
}
export type SDKUIElementAddress = { plugin: string; key: string }
export type SDKUIBench = { seq: number; t0: number }
export type SDKUIHandler = { plugin: string; handle: number }
export type SDKUIStyle = Record<string, string | number | boolean>
export type SDKUIRenderChild = string | SDKUIRenderElement
/** Wire trees contain handles and module paths, never functions or host objects. */
export type SDKUIRenderElement =
  | {
      type: 'Box' | 'Text' | 'div' | 'span' | 'b'
      props?: SDKUIStyle
      hover?: SDKUIStyle
      group?: { plugin: string }
      children?: SDKUIRenderChild[]
    }
  | {
      type: 'Button'
      props: {
        key: string
        label: string
        hotkey?: string
        action?: string
        plain?: true
        dimColor?: boolean
        variant?: 'primary' | 'secondary'
        role?: 'dismiss'
        autoFocus?: boolean
      }
      press: SDKUIHandler
      hover?: SDKUIStyle
    }
  | {
      type: 'Input'
      props: {
        key: string
        label?: string
        placeholder?: string
        value?: string
        submitLabel?: string
        autoFocus?: boolean
      }
      press: SDKUIHandler
    }
  | {
      type: 'Select'
      props: {
        key: string
        label?: string
        options: { value: string; label?: string }[]
        value?: string
        autoFocus?: boolean
      }
      press: SDKUIHandler
    }
  | {
      type: 'Link'
      props: { href: string; label?: string }
      children?: SDKUIRenderChild[]
    }
  | {
      type: 'Code'
      props: {
        source: string
        language?: string
        path?: string
        startLine?: number
        format?: 'source' | 'diff'
        wrap?: 'wrap' | 'truncate-end'
      }
    }
  | {
      type: 'Markdown'
      props: {
        key?: string
        text: string
        dimColor?: boolean
        pressableLinks?: string[]
      }
      press?: SDKUIHandler
    }
  | {
      type: 'Client'
      props: {
        key: string
        module: string
        props?: unknown
        width?: number | string
        height?: number | string
        flexGrow?: number
      }
      client: { plugin: string }
    }
  | {
      type: 'Svg'
      props: {
        source: string
        alt: string
        width?: number
        height?: number
        isInteractive?: boolean
      }
    }
  | { type: 'engine'; ref: number }

type SDKUIClientRoute = { surface?: SDKUIRemoteSurface; client_id?: string }
export type SDKControlUIAttachRequest = {
  subtype: 'ui_attach'
  surface: SDKUIRemoteSurface
  client_id: string
  viewport?: SDKUIViewport
  answers?: SDKUIAnswer[]
}
export type SDKControlUIDetachRequest = {
  subtype: 'ui_detach'
  client_id: string
}
export type SDKControlUIAttachResponse = { surfaces: SDKUISurface[] }
export type SDKControlUIDetachResponse = SDKControlUIAttachResponse & {
  detached: boolean
}
export type SDKControlUIRenderRequest = {
  subtype: 'ui_render'
  surface: SDKUIRemoteSurface
  client_id?: string
  component: SDKUIRenderComponent
  instance_id: string
  props: Record<string, unknown>
  viewport?: SDKUIViewport
  on_screen?: SDKUIOnScreen | null
  content_rows?: number
  keyed?: SDKUIKeyedRows[]
  bench?: SDKUIBench
}
export type SDKControlUIRenderResponse = {
  tree: SDKUIRenderElement
  props: Record<string, unknown>
  rewritten: boolean
  hooked: boolean
  client_modules?: Record<string, string>
  bench?: SDKUIBench
}
export type SDKControlUIPressRequest = SDKUIClientRoute & {
  subtype: 'ui_press'
  plugin: string
  handle: number
  key?: string
  href?: string
}
export type SDKControlUIPressResponse = { handled: boolean; element?: string }
type SDKUIInputAddress = SDKUIClientRoute & {
  plugin: string
  handle: number
  key?: string
  component?: SDKUIRenderComponent
  instance_id?: string
}
export type SDKControlUIInputRequest = SDKUIInputAddress & {
  subtype: 'ui_input'
  kind: 'change' | 'submit'
  value: string
}
export type SDKControlUISelectRequest = SDKUIInputAddress & {
  subtype: 'ui_select'
  value: string
}
export type SDKControlUIInputResponse = {
  handled: boolean
  element?: string
  value?: string
}
export type SDKControlUISelectResponse = SDKControlUIInputResponse
export type SDKUIPromptKey = {
  key: string
  ctrl?: true
  shift?: true
  meta?: true
}
export type SDKUIPromptDecoration = {
  start: number
  end: number
  color?: string
  backgroundColor?: string
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}
export type SDKControlUIPromptEditRequest = SDKUIClientRoute & {
  subtype: 'ui_prompt_edit'
  text: string
  cursor: number
  key?: SDKUIPromptKey
  by?: 'person' | 'app'
}
export type SDKControlUIPromptEditResponse = {
  text: string
  cursor: number
  decorations?: SDKUIPromptDecoration[]
  superseded?: true
}
export type SDKControlUIPromptAutocompleteRequest = SDKUIClientRoute & {
  subtype: 'ui_prompt_autocomplete'
  text: string
  cursor: number
}
export type SDKControlUIPromptAutocompleteResponse = {
  suggestions: { text: string; label?: string; description?: string }[]
  start?: number
  superseded?: true
}
export type SDKUIPane = {
  id: string
  title: string
  plugin: string
  close_on_escape?: true
  hold_toasts?: true
  rows?: number
  columns?: number
}
export type SDKControlUIPanesRequest = {
  subtype: 'ui_panes'
  client_id?: string
}
export type SDKControlUIPanesResponse = {
  panes: SDKUIPane[]
  shown_id: string | null
  focused_id: string | null
  focus_requested_id: string | null
}
export type SDKControlUIPaneShowRequest = SDKUIClientRoute & {
  subtype: 'ui_pane_show'
  id: string
}
export type SDKControlUIPaneShowResponse = { shown_id: string | null }
export type SDKControlUIPaneFocusRequest = SDKUIClientRoute & {
  subtype: 'ui_pane_focus'
  id: string | null
}
export type SDKControlUIPaneFocusResponse = { focused_id: string | null }
export type SDKControlUICloseRequest = {
  subtype: 'ui_close'
  id: string
  client_id?: string
}
export type SDKControlUICloseResponse = { closed: boolean }
export type SDKControlUIScrollRequest = SDKUIClientRoute & {
  subtype: 'ui_scroll'
  component: SDKUIScrollComponent
  instance_id: string
  offset: number
  by: number
  body_rows: number
  content_rows: number
  pointer?: { column: number; row: number }
  keyed?: SDKUIKeyedRows[]
}
export type SDKControlUIScrollResponse = {
  moved: boolean
  offset: number
  deny?: string
  follow_end?: boolean
}
export type SDKControlUIFocusRequest = SDKUIClientRoute & {
  subtype: 'ui_focus'
  component: SDKUIScrollComponent
  instance_id: string
  is_held: boolean
  element?: SDKUIElementAddress | null
  by?: 'person' | 'auto'
}
export type SDKControlUIFocusResponse = {
  moved: boolean
  element: SDKUIElementAddress | null
  deny?: string
}
export type SDKUIClientAddress = {
  plugin: string
  component: SDKUIRenderComponent
  instance_id: string
  client: string
  module: string
}
export type SDKControlUIClientModuleRequest = {
  subtype: 'ui_client_module'
  plugin: string
}
export type SDKControlUIClientModuleResponse = {
  plugin: string
  hash: string
  modules: { module: string; entry: string; component: string }[]
  runtime: string
  limits: {
    nodes: number
    depth: number
    chars: number
    values: number
    dataDepth: number
  }
  files: { key: string; source: string }[]
}
export type SDKUIClientPressEvent =
  | { type: 'press' }
  | { type: 'input'; kind: 'change' | 'submit'; value: string }
  | { type: 'select'; value: string }
export type SDKControlUIClientPressRequest = SDKUIClientAddress & {
  subtype: 'ui_client_press'
  element: string
  event: SDKUIClientPressEvent
}
export type SDKControlUIClientPressResponse = {
  handled: boolean
  reached?: Record<string, unknown>
}
export type SDKControlUIMessageRequest = SDKUIClientAddress & {
  subtype: 'ui_message'
  data: unknown
}
export type SDKControlUIMessageResponse = { handled: boolean; props?: unknown }
export type SDKControlUIClientFaultRequest = SDKUIClientAddress & {
  subtype: 'ui_client_fault'
  phase: 'load' | 'render' | 'run'
  reason: string
}
export type SDKControlUIClientFaultResponse = { handled: boolean }
type SDKUIResponderRoute = { surface: SDKUIRemoteSurface; client_id: string }
export type SDKControlUICopyRequest = SDKUIResponderRoute & {
  subtype: 'ui_copy'
  plugin: string
  text: string
}
export type SDKControlUICopyResponse = { copied: boolean }
export type SDKControlUIPromptReadRequest = SDKUIResponderRoute & {
  subtype: 'ui_prompt_read'
}
export type SDKControlUIPromptReadResponse = { text: string; cursor: number }
export type SDKControlUIPromptFillRequest = SDKUIResponderRoute & {
  subtype: 'ui_prompt_fill'
  text: string
  mode: 'replace' | 'append' | 'insert'
  decorations?: SDKUIPromptDecoration[]
}
export type SDKControlUIPromptFillResponse = { filled: boolean }
export type SDKControlUIPromptSuggestRequest = SDKUIResponderRoute & {
  subtype: 'ui_prompt_suggest'
  text: string
}
export type SDKControlUIPromptSuggestResponse = { shown: boolean }
export type SDKControlUIReadSelectionRequest = SDKUIResponderRoute & {
  subtype: 'ui_read_selection'
}
export type SDKControlUIReadSelectionResponse = {
  text?: string
  instance_id?: string
}

/** Client -> loop requests. Declaring a protocol shape does not install its controller. */
export type SDKControlUIClientRequest =
  | SDKControlUIAttachRequest
  | SDKControlUIDetachRequest
  | SDKControlUIRenderRequest
  | SDKControlUIPressRequest
  | SDKControlUIInputRequest
  | SDKControlUISelectRequest
  | SDKControlUIPromptEditRequest
  | SDKControlUIPromptAutocompleteRequest
  | SDKControlUIPanesRequest
  | SDKControlUIPaneShowRequest
  | SDKControlUIPaneFocusRequest
  | SDKControlUICloseRequest
  | SDKControlUIScrollRequest
  | SDKControlUIFocusRequest
  | SDKControlUIClientModuleRequest
  | SDKControlUIClientPressRequest
  | SDKControlUIMessageRequest
  | SDKControlUIClientFaultRequest
/** Loop -> client requests use the surface's advertised responders. */
export type SDKControlUILoopRequest =
  | SDKControlUICopyRequest
  | SDKControlUIPromptReadRequest
  | SDKControlUIPromptFillRequest
  | SDKControlUIPromptSuggestRequest
  | SDKControlUIReadSelectionRequest
export type SDKControlUIRequest =
  | SDKControlUIClientRequest
  | SDKControlUILoopRequest
export type SDKControlUIResponseBySubtype = {
  ui_attach: SDKControlUIAttachResponse
  ui_detach: SDKControlUIDetachResponse
  ui_render: SDKControlUIRenderResponse
  ui_press: SDKControlUIPressResponse
  ui_input: SDKControlUIInputResponse
  ui_select: SDKControlUISelectResponse
  ui_prompt_edit: SDKControlUIPromptEditResponse
  ui_prompt_autocomplete: SDKControlUIPromptAutocompleteResponse
  ui_panes: SDKControlUIPanesResponse
  ui_pane_show: SDKControlUIPaneShowResponse
  ui_pane_focus: SDKControlUIPaneFocusResponse
  ui_close: SDKControlUICloseResponse
  ui_scroll: SDKControlUIScrollResponse
  ui_focus: SDKControlUIFocusResponse
  ui_client_module: SDKControlUIClientModuleResponse
  ui_client_press: SDKControlUIClientPressResponse
  ui_message: SDKControlUIMessageResponse
  ui_client_fault: SDKControlUIClientFaultResponse
  ui_copy: SDKControlUICopyResponse
  ui_prompt_read: SDKControlUIPromptReadResponse
  ui_prompt_fill: SDKControlUIPromptFillResponse
  ui_prompt_suggest: SDKControlUIPromptSuggestResponse
  ui_read_selection: SDKControlUIReadSelectionResponse
}
export type SDKControlUIResponseFor<T extends SDKControlUIRequest> =
  SDKControlUIResponseBySubtype[T['subtype']]

type SDKUISystemEnvelope = { type: 'system'; uuid: string; session_id: string }
export type SDKUIPanesMessage = SDKUISystemEnvelope &
  SDKControlUIPanesResponse & { subtype: 'ui_panes' }
export type SDKUIScrollMessage = SDKUISystemEnvelope & {
  subtype: 'ui_scroll'
  client_id: string
  component: SDKUIScrollComponent
  instance_id: string
  offset: number
  follow_end?: boolean
}
export type SDKUIFocusMessage = SDKUISystemEnvelope & {
  subtype: 'ui_focus'
  client_id: string
  component: SDKUIScrollComponent
  instance_id: string
  plugin: string
  key: string
}
export type SDKUISystemMessage =
  | SDKUIPanesMessage
  | SDKUIScrollMessage
  | SDKUIFocusMessage
