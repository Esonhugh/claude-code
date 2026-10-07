import type { z } from 'zod/v4'
import type {
  SDKControlUIRequest,
  SDKControlUIResponseBySubtype,
  SDKControlUIRenderRequest,
  SDKControlUIRenderResponse,
  SDKControlUIPaneFocusRequest,
  SDKControlUIPanesResponse,
  SDKControlUIFocusResponse,
  SDKControlUIResponseFor,
  SDKControlUILoopRequest,
} from '../../src/entrypoints/sdk/modsControlTypes.js'
import type {
  SDKControlUIRequestSchema,
  SDKControlUIResponseSchemas,
} from '../../src/entrypoints/sdk/modsControlSchemas.js'

type Assert<T extends true> = T
type ResponseSchemas = typeof SDKControlUIResponseSchemas
type ResponseOutput<K extends keyof ResponseSchemas> = z.output<
  ReturnType<ResponseSchemas[K]>
>
type ResponsesMatch = {
  [K in keyof SDKControlUIResponseBySubtype]: ResponseOutput<K> extends SDKControlUIResponseBySubtype[K]
    ? SDKControlUIResponseBySubtype[K] extends ResponseOutput<K>
      ? true
      : false
    : false
}[keyof SDKControlUIResponseBySubtype]
export type ExactResponses = Assert<ResponsesMatch>
type RequestInput = z.input<ReturnType<typeof SDKControlUIRequestSchema>>
export type InputCoversWireRequests = Assert<
  SDKControlUIRequest extends RequestInput ? true : false
>
export type WireCoversInput = Assert<
  RequestInput extends SDKControlUIRequest ? true : false
>
export type ParsedRequestFitsWire = Assert<
  z.output<
    ReturnType<typeof SDKControlUIRequestSchema>
  > extends SDKControlUIRequest
    ? true
    : false
>
export type EveryRequestHasResponse = Assert<
  SDKControlUIRequest['subtype'] extends keyof SDKControlUIResponseBySubtype
    ? true
    : false
>
export type EveryResponseHasRequest = Assert<
  keyof SDKControlUIResponseBySubtype extends SDKControlUIRequest['subtype']
    ? true
    : false
>

const render: SDKControlUIRenderRequest = {
  subtype: 'ui_render',
  surface: 'desktop',
  component: 'Pane',
  instance_id: 'pane',
  props: {},
  on_screen: null,
}
const response: SDKControlUIResponseFor<typeof render> = {
  tree: { type: 'engine', ref: 0 },
  props: {},
  rewritten: false,
  hooked: false,
}
const focus: SDKControlUIPaneFocusRequest = {
  subtype: 'ui_pane_focus',
  id: null,
}
const panes: SDKControlUIPanesResponse = {
  panes: [],
  shown_id: null,
  focused_id: null,
  focus_requested_id: null,
}
const focusResponse: SDKControlUIFocusResponse = {
  moved: false,
  element: null,
}
// @ts-expect-error A nullable required field cannot be omitted.
const missingPaneId: SDKControlUIPaneFocusRequest = {
  subtype: 'ui_pane_focus',
}
// @ts-expect-error All three nullable roster IDs remain required.
const missingRosterId: SDKControlUIPanesResponse = {
  panes: [],
  shown_id: null,
  focused_id: null,
}
// @ts-expect-error A failed focus still carries its nullable element.
const missingElement: SDKControlUIFocusResponse = { moved: false }
// @ts-expect-error Render responses require their props and both flags.
const missingProps: SDKControlUIRenderResponse = {
  tree: { type: 'engine', ref: 0 },
  rewritten: false,
  hooked: false,
}
const wrongDirection: SDKControlUILoopRequest = {
  // @ts-expect-error Client input must not be mistaken for a loop responder request.
  subtype: 'ui_input',
  plugin: 'p',
  handle: 1,
  kind: 'change',
  value: '',
}
void [
  response,
  focus,
  panes,
  focusResponse,
  missingPaneId,
  missingRosterId,
  missingElement,
  missingProps,
  wrongDirection,
]
