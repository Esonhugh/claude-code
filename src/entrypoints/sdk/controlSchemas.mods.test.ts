import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  SDKControlRequestSchema,
  SDKControlUIRequestSchema,
  SDKControlUIClientRequestSchema,
  SDKControlUILoopRequestSchema,
  SDKControlUIResponseSchemas,
  SDKUIRenderElementSchema,
  SDKUISystemMessageSchema,
  SDKUIPromptDecorationSchema,
} from './controlSchemas.js'
import type {
  SDKControlUIRequest,
  SDKControlUIClientRequest,
  SDKControlUILoopRequest,
  SDKControlUIResponseBySubtype,
  SDKControlUIResponseFor,
  SDKControlUIRenderRequest,
  SDKUIRenderElement,
  SDKUISystemMessage,
} from './controlTypes.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import {
  createModRemoteUIControl,
  modUIAttachError,
} from '../../services/mods/remoteUiControl.js'
import official from './fixtures/mods-ui-official-292.json'

const route = { surface: 'desktop', client_id: 'desktop.main' } as const
const client = {
  plugin: 'p',
  component: 'Pane',
  instance_id: 'pane',
  client: 'view',
  module: 'hooks/view.tsx',
} as const
const requests = [
  { subtype: 'ui_attach', ...route, answers: ['ui_copy'] },
  { subtype: 'ui_detach', client_id: route.client_id },
  {
    subtype: 'ui_render',
    ...route,
    component: 'ToolUse',
    instance_id: 'tool:1',
    props: { input: { command: 'pwd' } },
  },
  { subtype: 'ui_press', plugin: 'p', handle: -1 },
  {
    subtype: 'ui_input',
    plugin: 'p',
    handle: 1,
    kind: 'change',
    value: 'text',
  },
  { subtype: 'ui_select', plugin: 'p', handle: 2, value: 'a' },
  { subtype: 'ui_prompt_edit', text: 'draft', cursor: 99 },
  { subtype: 'ui_prompt_autocomplete', text: '/custom', cursor: 7 },
  { subtype: 'ui_panes' },
  { subtype: 'ui_pane_show', id: 'pane' },
  { subtype: 'ui_pane_focus', id: null },
  { subtype: 'ui_close', id: 'pane' },
  {
    subtype: 'ui_scroll',
    component: 'AbovePrompt',
    instance_id: 'above-prompt',
    offset: 0,
    by: -2,
    body_rows: 0,
    content_rows: 0,
  },
  {
    subtype: 'ui_focus',
    component: 'Pane',
    instance_id: 'pane',
    is_held: false,
    element: null,
  },
  { subtype: 'ui_client_module', plugin: 'p' },
  {
    subtype: 'ui_client_press',
    ...client,
    element: 'button',
    event: { type: 'press' },
  },
  { subtype: 'ui_message', ...client, data: null },
  {
    subtype: 'ui_client_fault',
    ...client,
    phase: 'render',
    reason: 'bounded error',
  },
  { subtype: 'ui_copy', ...route, plugin: 'p', text: 'copy' },
  { subtype: 'ui_prompt_read', ...route },
  {
    subtype: 'ui_prompt_fill',
    ...route,
    text: 'draft',
    mode: 'replace',
    decorations: [{ start: 0, end: 5, bold: true }],
  },
  { subtype: 'ui_prompt_suggest', ...route, text: 'next' },
  { subtype: 'ui_read_selection', ...route },
] satisfies SDKControlUIRequest[]
const responses = {
  ui_attach: { surfaces: ['desktop'] },
  ui_detach: { detached: true, surfaces: [] },
  ui_render: {
    tree: { type: 'engine', ref: 0 },
    props: {},
    rewritten: false,
    hooked: false,
    client_modules: { p: 'hash' },
    bench: { seq: 1, t0: 1.25 },
  },
  ui_press: { handled: true, element: 'button' },
  ui_input: { handled: true, element: 'input', value: 'text' },
  ui_select: { handled: false },
  ui_prompt_edit: { text: 'draft', cursor: 5, superseded: true },
  ui_prompt_autocomplete: { suggestions: [], superseded: true },
  ui_panes: {
    panes: [
      { id: 'pane', title: 'Review', plugin: 'p', close_on_escape: true },
    ],
    shown_id: 'pane',
    focused_id: null,
    focus_requested_id: null,
  },
  ui_pane_show: { shown_id: 'pane' },
  ui_pane_focus: { focused_id: null },
  ui_close: { closed: true },
  ui_scroll: { moved: true, offset: 0, follow_end: true },
  ui_focus: { moved: false, element: null, deny: 'not held' },
  ui_client_module: {
    plugin: 'p',
    hash: 'hash',
    modules: [
      {
        module: 'hooks/view.tsx',
        entry: 'surface:///hooks/view.tsx',
        component: 'default',
      },
    ],
    runtime: 'claude:surface-runtime',
    limits: { nodes: 1, depth: 1, chars: 1, values: 1, dataDepth: 1 },
    files: [
      {
        key: 'surface:///hooks/view.tsx',
        source: 'export default function View(){}',
      },
    ],
  },
  ui_client_press: { handled: true, reached: { element: 'button' } },
  ui_message: { handled: true, props: { value: 'updated' } },
  ui_client_fault: { handled: true },
  ui_copy: { copied: true },
  ui_prompt_read: { text: 'draft', cursor: 5 },
  ui_prompt_fill: { filled: true },
  ui_prompt_suggest: { shown: false },
  ui_read_selection: { text: 'selected', instance_id: 'pane' },
} satisfies SDKControlUIResponseBySubtype

// The checks below are compiled by release-check, without executing malformed examples.
function staticContracts() {
  const render: SDKControlUIRenderRequest = {
    subtype: 'ui_render',
    surface: 'mobile',
    component: 'ToolResult',
    instance_id: '',
    props: {},
    on_screen: null,
  }
  const response: SDKControlUIResponseFor<typeof render> = responses.ui_render
  const parsed: unknown = SDKControlUIRequestSchema().parse(render)
  const clientOnly: unknown = SDKControlUIClientRequestSchema().parse(
    requests[0],
  )
  const loopOnly: SDKControlUILoopRequest =
    SDKControlUILoopRequestSchema().parse(requests[18])
  const schemaInput: z.input<ReturnType<typeof SDKControlUIRequestSchema>> =
    requests[3]
  const terminal: SDKControlUIRenderRequest = {
    ...render,
    // @ts-expect-error A terminal drawing is not a remote request.
    surface: 'terminal',
  }
  const invented: SDKControlUIRenderRequest = {
    ...render,
    // @ts-expect-error The component list is finite.
    component: 'UnknownComponent',
  }
  const executable: SDKUIRenderElement = {
    type: 'Client',
    // @ts-expect-error A Client wire tree carries module data, not a renderer function.
    props: { key: 'k', module: () => {} },
    client: { plugin: 'p' },
  }
  const key: SDKControlUIRequest = {
    subtype: 'ui_prompt_edit',
    text: '',
    cursor: 0,
    // @ts-expect-error Modifier fields are present only when held.
    key: { key: 'a', ctrl: false },
  }
  type CopyResponse = SDKControlUIResponseFor<
    Extract<SDKControlUIRequest, { subtype: 'ui_copy' }>
  >
  // @ts-expect-error Responder results use copied, rather than the author operation's isCopied.
  const copied: CopyResponse = { isCopied: true }
  // @ts-expect-error Official ui_message requires its data field (null is valid).
  const message: SDKControlUIRequest = { subtype: 'ui_message', ...client }
  const wrongDirection: SDKControlUIClientRequest = {
    // @ts-expect-error Read-selection responders run in the opposite direction.
    subtype: 'ui_read_selection',
    ...route,
  }
  void [
    response,
    parsed,
    clientOnly,
    loopOnly,
    schemaInput,
    terminal,
    invented,
    executable,
    key,
    copied,
    message,
    wrongDirection,
  ]
}
void staticContracts

describe('official 2.1.292 Mods UI wire contracts', () => {
  test.each(
    official.receipts.map(
      (receipt) => [receipt.request.request_id, receipt] as const,
    ),
  )('actual official receipt %s', (_id, receipt) => {
    expect(official.source.version).toBe('2.1.292')
    expect(SDKControlRequestSchema().safeParse(receipt.request).success).toBe(
      receipt.requestValid,
    )
    if (receipt.response.subtype === 'success') {
      const subtype = receipt.request.request
        .subtype as keyof typeof SDKControlUIResponseSchemas
      expect(
        SDKControlUIResponseSchemas[subtype]().safeParse(
          receipt.response.response,
        ).success,
      ).toBe(true)
    }
  })

  test.each(requests.map((request) => [request.subtype, request] as const))(
    '%s request and its response',
    (subtype, request) => {
      expect(SDKControlUIRequestSchema().safeParse(request).success).toBe(true)
      expect(
        SDKControlRequestSchema().safeParse({
          type: 'control_request',
          request_id: subtype,
          request,
        }).success,
      ).toBe(true)
      expect(
        SDKControlUIResponseSchemas[subtype]().safeParse(responses[subtype])
          .success,
      ).toBe(true)
      expect(SDKControlUIResponseSchemas[subtype]().safeParse({}).success).toBe(
        subtype === 'ui_read_selection',
      )
    },
  )

  test('client and loop directions stay separate', () => {
    for (const request of requests) {
      const loop = [
        'ui_copy',
        'ui_prompt_read',
        'ui_prompt_fill',
        'ui_prompt_suggest',
        'ui_read_selection',
      ].includes(request.subtype)
      expect(SDKControlUIClientRequestSchema().safeParse(request).success).toBe(
        !loop,
      )
      expect(SDKControlUILoopRequestSchema().safeParse(request).success).toBe(
        loop,
      )
    }
  })

  test('surface and origin defaults apply only to controls that define them', () => {
    expect(
      SDKControlUIRequestSchema().parse({
        subtype: 'ui_prompt_edit',
        text: '',
        cursor: 999,
      }),
    ).toEqual({
      subtype: 'ui_prompt_edit',
      text: '',
      cursor: 999,
      surface: 'desktop',
      by: 'person',
    })
    expect(
      SDKControlUIRequestSchema().parse({
        subtype: 'ui_focus',
        component: 'Pane',
        instance_id: '',
        is_held: true,
      }),
    ).toEqual({
      subtype: 'ui_focus',
      component: 'Pane',
      instance_id: '',
      is_held: true,
      surface: 'desktop',
      by: 'person',
    })
    expect(SDKControlUIRequestSchema().parse({ subtype: 'ui_panes' })).toEqual({
      subtype: 'ui_panes',
    })
    for (const subtype of [
      'ui_attach',
      'ui_render',
      'ui_copy',
      'ui_prompt_read',
      'ui_prompt_fill',
      'ui_prompt_suggest',
      'ui_read_selection',
    ]) {
      const request = { ...requests.find((r) => r.subtype === subtype)! }
      delete (request as { surface?: string }).surface
      expect(SDKControlUIRequestSchema().safeParse(request).success).toBe(false)
    }
  })

  test('client IDs allow dots; pane IDs do not; engine colon is never client input', () => {
    const attach = {
      subtype: 'ui_attach',
      surface: 'desktop',
      client_id: 'a'.repeat(64),
    }
    expect(SDKControlUIRequestSchema().safeParse(attach).success).toBe(true)
    for (const client_id of [
      '',
      'a'.repeat(65),
      'desktop:default',
      '中文',
      'a/b',
      'a b',
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...attach, client_id }).success,
      ).toBe(false)
    expect(
      SDKControlUIRequestSchema().safeParse({ ...attach, client_id: 'a.b' })
        .success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({ subtype: 'ui_close', id: 'a.b' })
        .success,
    ).toBe(false)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_pane_focus',
        id: null,
      }).success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_pane_show',
        id: null,
      }).success,
    ).toBe(false)
  })

  test('answers accepts five repeated entries and rejects a sixth before mutating the roster', async () => {
    const runtime = createModsRuntime()
    await runtime.bind({
      cwd: process.cwd(),
      surface: null,
      isInteractive: false,
      sessionId: 'protocol-limit',
    })
    const receipts: unknown[] = []
    const control = createModRemoteUIControl({
      runtime: () => runtime,
      success: (_m, value) => receipts.push(value),
      error: (_m, error) => receipts.push(error),
    })
    try {
      for (const [client_id, count] of [
        ['five', 5],
        ['six', 6],
      ] as const)
        control.handleRequest({
          type: 'control_request',
          request_id: client_id,
          request: {
            subtype: 'ui_attach',
            surface: count === 5 ? 'desktop' : 'mobile',
            client_id,
            answers: Array(count).fill('ui_copy'),
          },
        })
      await control.settle()
      expect(receipts).toEqual([{ surfaces: ['desktop'] }, modUIAttachError])
      expect(runtime.remoteClients.surfaces()).toEqual(['desktop'])
      expect(runtime.remoteClients.detach('six').detached).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  test('render accepts all 15 sites; transcript windows have inclusive valid bounds', () => {
    const render = requests[2]
    for (const component of [
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
    ]) {
      expect(
        SDKControlUIRequestSchema().safeParse({ ...render, component }).success,
      ).toBe(true)
    }
    for (const on_screen of [
      undefined,
      null,
      { first: 0, last: 0, of: 1 },
      { first: 2, last: 4, of: 5 },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...render, on_screen }).success,
      ).toBe(true)
    for (const on_screen of [
      { first: -1, last: 0, of: 1 },
      { first: 1, last: 0, of: 2 },
      { first: 0, last: 1, of: 1 },
      { first: 0, last: 0, of: 0 },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...render, on_screen }).success,
      ).toBe(false)
    for (const props of [null, [], 'props'])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...render, props }).success,
      ).toBe(false)
    // Wire schema accepts this; component normalization and readonly fields belong to the renderer.
    expect(
      SDKControlUIRequestSchema().safeParse({
        ...render,
        instance_id: '',
        props: { onScreen: 'untrusted' },
        bench: { seq: -1, t0: 0.5 },
      }).success,
    ).toBe(true)
  })

  test('request-specific string bounds retain official asymmetries', () => {
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_press',
        plugin: 'p'.repeat(257),
        handle: -1,
        href: 'h'.repeat(2048),
      }).success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_press',
        plugin: 'p',
        handle: 0,
        href: 'h'.repeat(2049),
      }).success,
    ).toBe(false)
    for (const subtype of ['ui_input', 'ui_select']) {
      const request = {
        subtype,
        plugin: 'p'.repeat(256),
        handle: 0,
        kind: 'submit',
        value: 'x'.repeat(16384),
        key: 'k'.repeat(257),
        instance_id: 'i'.repeat(256),
      }
      expect(SDKControlUIRequestSchema().safeParse(request).success).toBe(true)
      for (const change of [
        { plugin: 'p'.repeat(257) },
        { instance_id: 'i'.repeat(257) },
        { value: 'x'.repeat(16385) },
        { handle: 0.5 },
      ])
        expect(
          SDKControlUIRequestSchema().safeParse({ ...request, ...change })
            .success,
        ).toBe(false)
    }
    expect(
      SDKControlUIRequestSchema().safeParse({
        ...requests[2],
        instance_id: 'i'.repeat(257),
      }).success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_client_module',
        plugin: 'p'.repeat(257),
      }).success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_client_fault',
        ...client,
        phase: 'run',
        reason: 'r'.repeat(200),
      }).success,
    ).toBe(true)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_client_fault',
        ...client,
        phase: 'run',
        reason: 'r'.repeat(201),
      }).success,
    ).toBe(false)
  })

  test('scroll allows signed deltas and pointer coordinates, with bounded rows and keys', () => {
    const scroll = {
      subtype: 'ui_scroll',
      component: 'Pane',
      instance_id: 'p',
      offset: 0,
      by: -2,
      body_rows: 0,
      content_rows: 0,
      pointer: { column: -1, row: -1 },
      keyed: Array(512).fill({ plugin: 'p', key: 'k', top: 2, bottom: 1 }),
    }
    expect(SDKControlUIRequestSchema().safeParse(scroll).success).toBe(true)
    for (const change of [
      { offset: -1 },
      { by: 0.5 },
      { body_rows: -1 },
      { content_rows: -1 },
      { component: 'ToolUse' },
      { keyed: [...scroll.keyed, scroll.keyed[0]] },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...scroll, ...change }).success,
      ).toBe(false)
    for (const viewport of [
      { columns: 0, rows: 1 },
      { columns: 1, rows: -1 },
      { columns: 1.5, rows: 2 },
      { columns: 1, rows: 1, isFullscreen: 1 },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...requests[2], viewport })
          .success,
      ).toBe(false)
  })

  test('prompt limits count UTF-16 units and modifiers only accept true', () => {
    const edit = {
      subtype: 'ui_prompt_edit',
      text: '😀'.repeat(500000),
      cursor: 1000000,
      key: { key: 'a', ctrl: true },
    }
    expect(SDKControlUIRequestSchema().safeParse(edit).success).toBe(true)
    for (const change of [
      { text: edit.text + 'x' },
      { cursor: -1 },
      { cursor: 0.5 },
      { key: { key: '' } },
      { key: { key: 'k'.repeat(33) } },
      { key: { key: 'a', ctrl: false } },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...edit, ...change }).success,
      ).toBe(false)
    expect(
      SDKUIPromptDecorationSchema().safeParse({ start: 0, end: 1, bold: true })
        .success,
    ).toBe(true)
    expect(
      SDKUIPromptDecorationSchema().safeParse({
        start: 0,
        end: 1,
        unknown: true,
      }).success,
    ).toBe(false)
  })

  test('client press events require the discriminated payload and bounded address', () => {
    const press = { subtype: 'ui_client_press', ...client, element: 'e' }
    for (const event of [
      { type: 'press' },
      { type: 'input', kind: 'change', value: '' },
      { type: 'input', kind: 'submit', value: '' },
      { type: 'select', value: '' },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...press, event }).success,
      ).toBe(true)
    for (const event of [
      { type: 'input', value: '' },
      { type: 'select' },
      { type: 'unknown' },
      { type: 'input', kind: 'change', value: 'x'.repeat(16385) },
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({ ...press, event }).success,
      ).toBe(false)
    for (const field of [
      'plugin',
      'instance_id',
      'client',
      'module',
      'element',
    ])
      expect(
        SDKControlUIRequestSchema().safeParse({
          ...press,
          [field]: 'x'.repeat(257),
          event: { type: 'press' },
        }).success,
      ).toBe(false)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_message',
        ...client,
      }).success,
    ).toBe(false)
    expect(
      SDKControlUIRequestSchema().safeParse({
        subtype: 'ui_message',
        ...client,
        data: null,
      }).success,
    ).toBe(true)
  })

  test('wire trees contain remote elements and callback handles', () => {
    const elements = [
      { type: 'Box', children: ['text', { type: 'engine', ref: 1 }] },
      { type: 'Text', children: ['text'] },
      { type: 'div' },
      { type: 'span' },
      { type: 'b' },
      {
        type: 'Button',
        props: { key: 'b', label: 'Run', variant: 'primary', role: 'dismiss' },
        press: { plugin: 'p', handle: 1 },
      },
      {
        type: 'Input',
        props: { key: 'i', submitLabel: 'Apply' },
        press: { plugin: 'p', handle: 2 },
      },
      {
        type: 'Select',
        props: { key: 's', options: [{ value: 'a' }] },
        press: { plugin: 'p', handle: 3 },
      },
      {
        type: 'Link',
        props: { href: 'https://example.invalid' },
        children: ['link'],
      },
      {
        type: 'Code',
        props: { source: '+added', format: 'diff', wrap: 'truncate-end' },
      },
      {
        type: 'Markdown',
        props: { text: 'text', pressableLinks: [] },
        press: { plugin: 'p', handle: 4 },
      },
      {
        type: 'Client',
        props: { key: 'c', module: 'hooks/view.tsx', props: { label: 'a' } },
        client: { plugin: 'p' },
      },
      {
        type: 'Svg',
        props: { source: '<svg/>', alt: 'preview', isInteractive: true },
      },
      { type: 'engine', ref: 0 },
    ] satisfies SDKUIRenderElement[]
    for (const element of elements)
      expect(SDKUIRenderElementSchema().parse(element)).toEqual(element)
    for (const element of [
      { type: 'Raster', props: {} },
      { type: 'Image', props: {} },
      { type: 'engine', ref: 0.5 },
      { type: 'Button', props: { key: 'k', label: 'Run' }, press: () => {} },
      {
        type: 'Select',
        props: { key: 'k', options: ['a'] },
        press: { plugin: 'p', handle: 1 },
      },
    ])
      expect(SDKUIRenderElementSchema().safeParse(element).success).toBe(false)
  })

  test('system pane, scroll and focus pushes use a different envelope', () => {
    const envelope = {
      type: 'system',
      uuid: 'f6a2364d-dd18-4a41-a7e8-1ec27a26cbd7',
      session_id: 'session',
    } as const
    const messages = [
      { ...envelope, subtype: 'ui_panes', ...responses.ui_panes },
      {
        ...envelope,
        subtype: 'ui_scroll',
        client_id: 'desktop:default',
        component: 'Pane',
        instance_id: 'pane',
        offset: 0,
        follow_end: true,
      },
      {
        ...envelope,
        subtype: 'ui_focus',
        client_id: 'desktop:default',
        component: 'Pane',
        instance_id: 'pane',
        plugin: 'p',
        key: 'b',
      },
    ] satisfies SDKUISystemMessage[]
    for (const message of messages) {
      expect(SDKUISystemMessageSchema().parse(message)).toEqual(message)
      expect(SDKControlRequestSchema().safeParse(message).success).toBe(false)
      // Official wire UUID fields are strings; the schema does not impose UUID syntax.
      expect(
        SDKUISystemMessageSchema().safeParse({ ...message, uuid: 'opaque-id' })
          .success,
      ).toBe(true)
    }
  })
})
