import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type {
  SDKUIRenderElement,
  SDKControlUIResponseBySubtype,
} from './modsControlTypes.js'

export const SDKUIRemoteSurfaceSchema = lazySchema(() =>
  z.enum(['desktop', 'mobile', 'vscode']),
)
export const SDKUISurfaceSchema = lazySchema(() =>
  z.enum(['terminal', 'desktop', 'mobile', 'vscode']),
)
export const SDKUIClientIdSchema = lazySchema(() =>
  z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
)
export const SDKUIPaneIdSchema = lazySchema(() =>
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
)
export const SDKUIViewportSchema = lazySchema(() =>
  z.object({
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    isFullscreen: z.boolean().optional(),
  }),
)
export const SDKUIRenderComponentSchema = lazySchema(() =>
  z.enum([
    'AskUserQuestion',
    'UserMessage',
    'AssistantMessage',
    'ToolUse',
    'ToolResult',
    'ToolGroup',
    'ToolProgress',
    'CommandOutput',
    'Spinner',
    'TurnDuration',
    'InfoNotice',
    'SessionMode',
    'PromptHint',
    'AbovePrompt',
    'Pane',
  ]),
)
export const SDKUIScrollComponentSchema = lazySchema(() =>
  z.enum(['Pane', 'AbovePrompt']),
)
export const SDKUIOnScreenSchema = lazySchema(() =>
  z
    .object({
      first: z.number().int().nonnegative(),
      last: z.number().int().nonnegative(),
      of: z.number().int().positive(),
    })
    .refine((value) => value.first <= value.last && value.last < value.of),
)
export const SDKUIKeyedRowsSchema = lazySchema(() =>
  z.object({
    plugin: z.string().max(256),
    key: z.string().max(256),
    top: z.number().int().nonnegative(),
    bottom: z.number().int().nonnegative(),
  }),
)
export const SDKUIElementAddressSchema = lazySchema(() =>
  z.object({ plugin: z.string().max(256), key: z.string().max(256) }),
)
export const SDKUIBenchSchema = lazySchema(() =>
  z.object({ seq: z.number().int(), t0: z.number() }),
)
export const SDKUIHandlerSchema = lazySchema(() =>
  z.object({ plugin: z.string(), handle: z.number().int() }),
)
export const SDKUIStyleSchema = lazySchema(() =>
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
)
export const SDKUIRenderElementSchema = lazySchema(
  (): z.ZodType<SDKUIRenderElement> =>
    z.union([
      z.object({
        type: z.enum(['Box', 'Text', 'div', 'span', 'b']),
        props: SDKUIStyleSchema().optional(),
        hover: SDKUIStyleSchema().optional(),
        group: z.object({ plugin: z.string() }).optional(),
        children: z
          .array(
            z.union([z.string(), z.lazy(() => SDKUIRenderElementSchema())]),
          )
          .optional(),
      }),
      z.object({
        type: z.literal('Button'),
        props: z.object({
          key: z.string(),
          label: z.string(),
          hotkey: z.string().optional(),
          action: z.string().optional(),
          plain: z.literal(true).optional(),
          dimColor: z.boolean().optional(),
          variant: z.enum(['primary', 'secondary']).optional(),
          role: z.literal('dismiss').optional(),
          autoFocus: z.boolean().optional(),
        }),
        press: SDKUIHandlerSchema(),
        hover: SDKUIStyleSchema().optional(),
      }),
      z.object({
        type: z.literal('Input'),
        props: z.object({
          key: z.string(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          value: z.string().optional(),
          submitLabel: z.string().optional(),
          autoFocus: z.boolean().optional(),
        }),
        press: SDKUIHandlerSchema(),
      }),
      z.object({
        type: z.literal('Select'),
        props: z.object({
          key: z.string(),
          label: z.string().optional(),
          options: z.array(
            z.object({ value: z.string(), label: z.string().optional() }),
          ),
          value: z.string().optional(),
          autoFocus: z.boolean().optional(),
        }),
        press: SDKUIHandlerSchema(),
      }),
      z.object({
        type: z.literal('Link'),
        props: z.object({ href: z.string(), label: z.string().optional() }),
        children: z
          .array(
            z.union([z.string(), z.lazy(() => SDKUIRenderElementSchema())]),
          )
          .optional(),
      }),
      z.object({
        type: z.literal('Code'),
        props: z.object({
          source: z.string(),
          language: z.string().optional(),
          path: z.string().optional(),
          startLine: z.number().int().optional(),
          format: z.enum(['source', 'diff']).optional(),
          wrap: z.enum(['wrap', 'truncate-end']).optional(),
        }),
      }),
      z.object({
        type: z.literal('Markdown'),
        props: z.object({
          key: z.string().optional(),
          text: z.string(),
          dimColor: z.boolean().optional(),
          pressableLinks: z.array(z.string()).optional(),
        }),
        press: SDKUIHandlerSchema().optional(),
      }),
      z.object({
        type: z.literal('Client'),
        props: z.object({
          key: z.string(),
          module: z.string(),
          props: z.unknown().optional(),
          width: z.union([z.number(), z.string()]).optional(),
          height: z.union([z.number(), z.string()]).optional(),
          flexGrow: z.number().optional(),
        }),
        client: z.object({ plugin: z.string() }),
      }),
      z.object({
        type: z.literal('Svg'),
        props: z.object({
          source: z.string(),
          alt: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
          isInteractive: z.boolean().optional(),
        }),
      }),
      z.object({ type: z.literal('engine'), ref: z.number().int() }),
    ]),
)

const uiAnswers = [
  'ui_copy',
  'ui_prompt_read',
  'ui_prompt_fill',
  'ui_prompt_suggest',
  'ui_read_selection',
] as const
export const SDKControlUIAttachRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_attach'),
    surface: SDKUIRemoteSurfaceSchema(),
    client_id: SDKUIClientIdSchema(),
    viewport: SDKUIViewportSchema().optional(),
    answers: z.array(z.enum(uiAnswers)).max(uiAnswers.length).optional(),
  }),
)
export const SDKControlUIDetachRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_detach'),
    client_id: SDKUIClientIdSchema(),
  }),
)
export const SDKControlUIRenderRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_render'),
    surface: SDKUIRemoteSurfaceSchema(),
    client_id: SDKUIClientIdSchema().optional(),
    component: SDKUIRenderComponentSchema(),
    instance_id: z.string(),
    props: z.record(z.string(), z.unknown()),
    viewport: SDKUIViewportSchema().optional(),
    on_screen: SDKUIOnScreenSchema().nullable().optional(),
    content_rows: z.number().int().nonnegative().optional(),
    keyed: z.array(SDKUIKeyedRowsSchema()).max(512).optional(),
    bench: SDKUIBenchSchema().optional(),
  }),
)
const clientRoute = () => ({
  surface: SDKUIRemoteSurfaceSchema().default('desktop'),
  client_id: SDKUIClientIdSchema().optional(),
})
export const SDKControlUIPressRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_press'),
    plugin: z.string(),
    handle: z.number().int(),
    key: z.string().optional(),
    href: z.string().max(2048).optional(),
    ...clientRoute(),
  }),
)
const inputAddress = () => ({
  plugin: z.string().max(256),
  handle: z.number().int(),
  key: z.string().optional(),
  component: SDKUIRenderComponentSchema().optional(),
  instance_id: z.string().max(256).optional(),
  ...clientRoute(),
})
export const SDKControlUIInputRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_input'),
    ...inputAddress(),
    kind: z.enum(['change', 'submit']),
    value: z.string().max(16384),
  }),
)
export const SDKControlUISelectRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_select'),
    ...inputAddress(),
    value: z.string().max(16384),
  }),
)
export const SDKUIPromptKeySchema = lazySchema(() =>
  z.object({
    key: z.string().min(1).max(32),
    ctrl: z.literal(true).optional(),
    shift: z.literal(true).optional(),
    meta: z.literal(true).optional(),
  }),
)
export const SDKUIPromptDecorationSchema = lazySchema(() =>
  z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int(),
    color: z.string().optional(),
    backgroundColor: z.string().optional(),
    dimColor: z.boolean().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
  }),
)
export const SDKControlUIPromptEditRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_prompt_edit'),
    text: z.string().max(1000000),
    cursor: z.number().int().nonnegative(),
    key: SDKUIPromptKeySchema().optional(),
    by: z.enum(['person', 'app']).default('person'),
    ...clientRoute(),
  }),
)
export const SDKControlUIPromptAutocompleteRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_prompt_autocomplete'),
    text: z.string().max(1000000),
    cursor: z.number().int().nonnegative(),
    ...clientRoute(),
  }),
)
export const SDKControlUIPanesRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_panes'),
    client_id: SDKUIClientIdSchema().optional(),
  }),
)
export const SDKControlUIPaneShowRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_pane_show'),
    id: SDKUIPaneIdSchema(),
    ...clientRoute(),
  }),
)
export const SDKControlUIPaneFocusRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_pane_focus'),
    id: SDKUIPaneIdSchema().nullable(),
    ...clientRoute(),
  }),
)
export const SDKControlUICloseRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_close'),
    id: SDKUIPaneIdSchema(),
    client_id: SDKUIClientIdSchema().optional(),
  }),
)
export const SDKControlUIScrollRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_scroll'),
    component: SDKUIScrollComponentSchema(),
    instance_id: z.string().max(256),
    offset: z.number().int().nonnegative(),
    by: z.number().int(),
    body_rows: z.number().int().nonnegative(),
    content_rows: z.number().int().nonnegative(),
    pointer: z
      .object({ column: z.number().int(), row: z.number().int() })
      .optional(),
    keyed: z.array(SDKUIKeyedRowsSchema()).max(512).optional(),
    ...clientRoute(),
  }),
)
export const SDKControlUIFocusRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_focus'),
    component: SDKUIScrollComponentSchema(),
    instance_id: z.string().max(256),
    is_held: z.boolean(),
    element: SDKUIElementAddressSchema().nullable().optional(),
    by: z.enum(['person', 'auto']).default('person'),
    ...clientRoute(),
  }),
)
export const SDKUIClientAddressSchema = lazySchema(() =>
  z.object({
    plugin: z.string().max(256),
    component: SDKUIRenderComponentSchema(),
    instance_id: z.string().max(256),
    client: z.string().max(256),
    module: z.string().max(256),
  }),
)
export const SDKControlUIClientModuleRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('ui_client_module'), plugin: z.string() }),
)
export const SDKUIClientPressEventSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('press') }),
    z.object({
      type: z.literal('input'),
      kind: z.enum(['change', 'submit']),
      value: z.string().max(16384),
    }),
    z.object({ type: z.literal('select'), value: z.string().max(16384) }),
  ]),
)
export const SDKControlUIClientPressRequestSchema = lazySchema(() =>
  SDKUIClientAddressSchema().extend({
    subtype: z.literal('ui_client_press'),
    element: z.string().max(256),
    event: SDKUIClientPressEventSchema(),
  }),
)
// The installed Zod admits a missing unknown slot; official native rejects it.
export const SDKControlUIMessageRequestSchema = lazySchema(() =>
  SDKUIClientAddressSchema()
    .extend({
      subtype: z.literal('ui_message'),
      data: z.unknown(),
    })
    .refine((value) => Object.hasOwn(value, 'data')),
)
export const SDKControlUIClientFaultRequestSchema = lazySchema(() =>
  SDKUIClientAddressSchema().extend({
    subtype: z.literal('ui_client_fault'),
    phase: z.enum(['load', 'render', 'run']),
    reason: z.string().max(200),
  }),
)
const responderRoute = () => ({
  surface: SDKUIRemoteSurfaceSchema(),
  client_id: SDKUIClientIdSchema(),
})
export const SDKControlUICopyRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_copy'),
    ...responderRoute(),
    plugin: z.string(),
    text: z.string().max(1000000),
  }),
)
export const SDKControlUIPromptReadRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('ui_prompt_read'), ...responderRoute() }),
)
export const SDKControlUIPromptFillRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_prompt_fill'),
    ...responderRoute(),
    text: z.string().max(1000000),
    mode: z.enum(['replace', 'append', 'insert']),
    decorations: z.array(SDKUIPromptDecorationSchema()).optional(),
  }),
)
export const SDKControlUIPromptSuggestRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('ui_prompt_suggest'),
    ...responderRoute(),
    text: z.string().max(1000000),
  }),
)
export const SDKControlUIReadSelectionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('ui_read_selection'), ...responderRoute() }),
)

export const SDKControlUIClientRequestSchema = lazySchema(() =>
  z.discriminatedUnion('subtype', [
    SDKControlUIAttachRequestSchema(),
    SDKControlUIDetachRequestSchema(),
    SDKControlUIRenderRequestSchema(),
    SDKControlUIPressRequestSchema(),
    SDKControlUIInputRequestSchema(),
    SDKControlUISelectRequestSchema(),
    SDKControlUIPromptEditRequestSchema(),
    SDKControlUIPromptAutocompleteRequestSchema(),
    SDKControlUIPanesRequestSchema(),
    SDKControlUIPaneShowRequestSchema(),
    SDKControlUIPaneFocusRequestSchema(),
    SDKControlUICloseRequestSchema(),
    SDKControlUIScrollRequestSchema(),
    SDKControlUIFocusRequestSchema(),
    SDKControlUIClientModuleRequestSchema(),
    SDKControlUIClientPressRequestSchema(),
    SDKControlUIMessageRequestSchema(),
    SDKControlUIClientFaultRequestSchema(),
  ]),
)
export const SDKControlUILoopRequestSchema = lazySchema(() =>
  z.discriminatedUnion('subtype', [
    SDKControlUICopyRequestSchema(),
    SDKControlUIPromptReadRequestSchema(),
    SDKControlUIPromptFillRequestSchema(),
    SDKControlUIPromptSuggestRequestSchema(),
    SDKControlUIReadSelectionRequestSchema(),
  ]),
)
export const SDKControlUIRequestSchema = lazySchema(() =>
  z.union([SDKControlUIClientRequestSchema(), SDKControlUILoopRequestSchema()]),
)

export const SDKControlUIAttachResponseSchema = lazySchema(() =>
  z.object({ surfaces: z.array(SDKUISurfaceSchema()) }),
)
export const SDKControlUIDetachResponseSchema = lazySchema(() =>
  SDKControlUIAttachResponseSchema().extend({ detached: z.boolean() }),
)
export const SDKControlUIRenderResponseSchema = lazySchema(() =>
  z.object({
    tree: SDKUIRenderElementSchema(),
    props: z.record(z.string(), z.unknown()),
    rewritten: z.boolean(),
    hooked: z.boolean(),
    client_modules: z.record(z.string(), z.string()).optional(),
    bench: SDKUIBenchSchema().optional(),
  }),
)
export const SDKControlUIPressResponseSchema = lazySchema(() =>
  z.object({ handled: z.boolean(), element: z.string().optional() }),
)
export const SDKControlUIInputResponseSchema = lazySchema(() =>
  SDKControlUIPressResponseSchema().extend({ value: z.string().optional() }),
)
export const SDKControlUISelectResponseSchema = SDKControlUIInputResponseSchema
export const SDKControlUIPromptEditResponseSchema = lazySchema(() =>
  z.object({
    text: z.string(),
    cursor: z.number().int(),
    decorations: z.array(SDKUIPromptDecorationSchema()).optional(),
    superseded: z.literal(true).optional(),
  }),
)
export const SDKControlUIPromptAutocompleteResponseSchema = lazySchema(() =>
  z.object({
    suggestions: z.array(
      z.object({
        text: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
      }),
    ),
    start: z.number().int().optional(),
    superseded: z.literal(true).optional(),
  }),
)
export const SDKUIPaneSchema = lazySchema(() =>
  z.object({
    id: SDKUIPaneIdSchema(),
    title: z.string(),
    plugin: z.string(),
    close_on_escape: z.literal(true).optional(),
    hold_toasts: z.literal(true).optional(),
    rows: z.number().int().optional(),
    columns: z.number().int().optional(),
  }),
)
export const SDKControlUIPanesResponseSchema = lazySchema(() =>
  z.object({
    panes: z.array(SDKUIPaneSchema()),
    shown_id: SDKUIPaneIdSchema().nullable(),
    focused_id: SDKUIPaneIdSchema().nullable(),
    focus_requested_id: SDKUIPaneIdSchema().nullable(),
  }),
)
export const SDKControlUIPaneShowResponseSchema = lazySchema(() =>
  z.object({ shown_id: SDKUIPaneIdSchema().nullable() }),
)
export const SDKControlUIPaneFocusResponseSchema = lazySchema(() =>
  z.object({ focused_id: SDKUIPaneIdSchema().nullable() }),
)
export const SDKControlUICloseResponseSchema = lazySchema(() =>
  z.object({ closed: z.boolean() }),
)
export const SDKControlUIScrollResponseSchema = lazySchema(() =>
  z.object({
    moved: z.boolean(),
    offset: z.number().int(),
    deny: z.string().optional(),
    follow_end: z.boolean().optional(),
  }),
)
export const SDKControlUIFocusResponseSchema = lazySchema(() =>
  z.object({
    moved: z.boolean(),
    element: SDKUIElementAddressSchema().nullable(),
    deny: z.string().optional(),
  }),
)
export const SDKControlUIClientModuleResponseSchema = lazySchema(() =>
  z.object({
    plugin: z.string(),
    hash: z.string(),
    modules: z.array(
      z.object({
        module: z.string(),
        entry: z.string(),
        component: z.string(),
      }),
    ),
    runtime: z.string(),
    limits: z.object({
      nodes: z.number().int(),
      depth: z.number().int(),
      chars: z.number().int(),
      values: z.number().int(),
      dataDepth: z.number().int(),
    }),
    files: z.array(z.object({ key: z.string(), source: z.string() })),
  }),
)
export const SDKControlUIClientPressResponseSchema = lazySchema(() =>
  z.object({
    handled: z.boolean(),
    reached: z.record(z.string(), z.unknown()).optional(),
  }),
)
export const SDKControlUIMessageResponseSchema = lazySchema(() =>
  z.object({ handled: z.boolean(), props: z.unknown().optional() }),
)
export const SDKControlUIClientFaultResponseSchema = lazySchema(() =>
  z.object({ handled: z.boolean() }),
)
export const SDKControlUICopyResponseSchema = lazySchema(() =>
  z.object({ copied: z.boolean() }),
)
export const SDKControlUIPromptReadResponseSchema = lazySchema(() =>
  z.object({ text: z.string(), cursor: z.number().int().nonnegative() }),
)
export const SDKControlUIPromptFillResponseSchema = lazySchema(() =>
  z.object({ filled: z.boolean() }),
)
export const SDKControlUIPromptSuggestResponseSchema = lazySchema(() =>
  z.object({ shown: z.boolean() }),
)
export const SDKControlUIReadSelectionResponseSchema = lazySchema(() =>
  z.object({ text: z.string().optional(), instance_id: z.string().optional() }),
)
export const SDKControlUIResponseSchemas = {
  ui_attach: SDKControlUIAttachResponseSchema,
  ui_detach: SDKControlUIDetachResponseSchema,
  ui_render: SDKControlUIRenderResponseSchema,
  ui_press: SDKControlUIPressResponseSchema,
  ui_input: SDKControlUIInputResponseSchema,
  ui_select: SDKControlUISelectResponseSchema,
  ui_prompt_edit: SDKControlUIPromptEditResponseSchema,
  ui_prompt_autocomplete: SDKControlUIPromptAutocompleteResponseSchema,
  ui_panes: SDKControlUIPanesResponseSchema,
  ui_pane_show: SDKControlUIPaneShowResponseSchema,
  ui_pane_focus: SDKControlUIPaneFocusResponseSchema,
  ui_close: SDKControlUICloseResponseSchema,
  ui_scroll: SDKControlUIScrollResponseSchema,
  ui_focus: SDKControlUIFocusResponseSchema,
  ui_client_module: SDKControlUIClientModuleResponseSchema,
  ui_client_press: SDKControlUIClientPressResponseSchema,
  ui_message: SDKControlUIMessageResponseSchema,
  ui_client_fault: SDKControlUIClientFaultResponseSchema,
  ui_copy: SDKControlUICopyResponseSchema,
  ui_prompt_read: SDKControlUIPromptReadResponseSchema,
  ui_prompt_fill: SDKControlUIPromptFillResponseSchema,
  ui_prompt_suggest: SDKControlUIPromptSuggestResponseSchema,
  ui_read_selection: SDKControlUIReadSelectionResponseSchema,
} satisfies { [K in keyof SDKControlUIResponseBySubtype]: () => z.ZodType }

const systemEnvelope = () => ({
  type: z.literal('system'),
  uuid: z.string(),
  session_id: z.string(),
})
export const SDKUIPanesMessageSchema = lazySchema(() =>
  SDKControlUIPanesResponseSchema().extend({
    ...systemEnvelope(),
    subtype: z.literal('ui_panes'),
  }),
)
export const SDKUIScrollMessageSchema = lazySchema(() =>
  z.object({
    ...systemEnvelope(),
    subtype: z.literal('ui_scroll'),
    client_id: z.string(),
    component: SDKUIScrollComponentSchema(),
    instance_id: z.string(),
    offset: z.number().int(),
    follow_end: z.boolean().optional(),
  }),
)
export const SDKUIFocusMessageSchema = lazySchema(() =>
  z.object({
    ...systemEnvelope(),
    subtype: z.literal('ui_focus'),
    client_id: z.string(),
    component: SDKUIScrollComponentSchema(),
    instance_id: z.string(),
    plugin: z.string(),
    key: z.string(),
  }),
)
export const SDKUISystemMessageSchema = lazySchema(() =>
  z.discriminatedUnion('subtype', [
    SDKUIPanesMessageSchema(),
    SDKUIScrollMessageSchema(),
    SDKUIFocusMessageSchema(),
  ]),
)
