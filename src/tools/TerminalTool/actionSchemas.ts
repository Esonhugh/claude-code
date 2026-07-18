import { z } from 'zod/v4'
import { SPECIAL_KEYS } from '../../utils/pty/types.js'

export const newSessionActionSchema = z.object({
  action: z.literal('new-session'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})

export const capturePaneActionSchema = z.object({
  action: z.literal('capture-pane'),
  target: z.string().min(1),
  cursor: z.number().int().min(0).default(0),
  maxBytes: z.number().int().positive().default(8192),
  mode: z.enum(['compact', 'full', 'save_file']).default('compact'),
  maxLines: z.number().int().positive().default(80),
  maxLineChars: z.number().int().positive().default(240),
  previewBytes: z.number().int().positive().default(2000),
})

export const listPanesActionSchema = z.object({
  action: z.literal('list-panes'),
})

export const sendKeysActionSchema = z.object({
  action: z.literal('send-keys'),
  target: z.string().min(1),
  text: z.string().optional(),
  key: z.enum(SPECIAL_KEYS).optional(),
  enter: z.boolean().optional(),
}).refine(input => input.text !== undefined || input.key !== undefined || input.enter === true, {
  message: 'send-keys requires text, key, or enter=true',
})

export const resizePaneActionSchema = z.object({
  action: z.literal('resize-pane'),
  target: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

export const sendSignalActionSchema = z.object({
  action: z.literal('send-signal'),
  target: z.string().min(1),
  signal: z.enum(['SIGINT', 'SIGTERM']),
})

export const displayMessageActionSchema = z.object({
  action: z.literal('display-message'),
  target: z.string().min(1),
})

export const killPaneActionSchema = z.object({
  action: z.literal('kill-pane'),
  target: z.string().min(1),
  force: z.boolean().optional(),
})

export const actionSchema = z.object({
  action: z.enum([
    'new-session',
    'list-panes',
    'send-keys',
    'capture-pane',
    'resize-pane',
    'send-signal',
    'display-message',
    'kill-pane',
  ]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  target: z.string().optional(),
  text: z.string().optional(),
  enter: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  maxBytes: z.number().int().positive().optional(),
  mode: z.enum(['compact', 'full', 'save_file']).optional(),
  maxLines: z.number().int().positive().optional(),
  maxLineChars: z.number().int().positive().optional(),
  previewBytes: z.number().int().positive().optional(),
  key: z.enum(SPECIAL_KEYS).optional(),
  signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
  force: z.boolean().optional(),
}).passthrough()
