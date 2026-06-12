import { z } from 'zod/v4'
import { SPECIAL_KEYS } from '../../utils/pty/types.js'

export const openActionSchema = z.object({
  action: z.literal('open'),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})

export const writeActionSchema = z.object({
  action: z.literal('write'),
  sessionId: z.string().min(1),
  text: z.string(),
  enter: z.boolean().optional(),
})

export const readActionSchema = z.object({
  action: z.literal('read'),
  sessionId: z.string().min(1),
  cursor: z.number().int().min(0).default(0),
  maxBytes: z.number().int().positive().default(8192),
})

export const sendKeyActionSchema = z.object({
  action: z.literal('send_key'),
  sessionId: z.string().min(1),
  key: z.enum(SPECIAL_KEYS),
})

export const resizeActionSchema = z.object({
  action: z.literal('resize'),
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

export const signalActionSchema = z.object({
  action: z.literal('signal'),
  sessionId: z.string().min(1),
  signal: z.enum(['SIGINT', 'SIGTERM']),
})

export const statusActionSchema = z.object({
  action: z.literal('status'),
  sessionId: z.string().min(1),
})

export const closeActionSchema = z.object({
  action: z.literal('close'),
  sessionId: z.string().min(1),
  force: z.boolean().optional(),
})

export const actionSchema = z.object({
  action: z.enum([
    'open',
    'write',
    'read',
    'send_key',
    'resize',
    'signal',
    'status',
    'close',
  ]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  text: z.string().optional(),
  enter: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  maxBytes: z.number().int().positive().optional(),
  key: z.enum(SPECIAL_KEYS).optional(),
  signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
  force: z.boolean().optional(),
}).passthrough()
