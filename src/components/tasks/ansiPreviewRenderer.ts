import * as React from 'react'
import { tokenize } from '@alcalzone/ansi-tokenize'
import { Text, type TextProps } from '../../ink.js'

type PreviewSegment = {
  text: string
  color?: TextProps['color']
}

export type PreviewLine = {
  key: string
  segments: PreviewSegment[]
}

export function renderAnsiPreviewLine(line: PreviewLine): React.ReactNode {
  return React.createElement(
    Text,
    { key: line.key, wrap: 'truncate-end' },
    ...line.segments.map((segment, index) =>
      React.createElement(
        Text,
        { key: `${line.key}-segment-${index}`, color: segment.color },
        segment.text,
      ),
    ),
  )
}

function ansiCodeToInkColor(code: string): TextProps['color'] | undefined {
  if (!code.startsWith('[') && code.charCodeAt(0) !== 27) {
    return undefined
  }

  const start = code.indexOf('[')
  const end = code.lastIndexOf('m')
  if (start === -1 || end === -1 || end <= start + 1) {
    return undefined
  }

  const colorCode = Number.parseInt(code.slice(start + 1, end), 10)
  switch (colorCode) {
    case 30:
      return 'ansi:black'
    case 31:
      return 'ansi:red'
    case 32:
      return 'ansi:green'
    case 33:
      return 'ansi:yellow'
    case 34:
      return 'ansi:blue'
    case 35:
      return 'ansi:magenta'
    case 36:
      return 'ansi:cyan'
    case 37:
      return 'ansi:white'
    default:
      return undefined
  }
}

export function renderAnsiPreviewLines(text: string, _cols: number): PreviewLine[] {
  const tokens = tokenize(text)
  const lines: PreviewLine[] = []
  let currentSegments: PreviewSegment[] = []
  let currentColor: TextProps['color'] | undefined
  let buffer = ''
  let lineIndex = 0

  function flushBuffer(): void {
    if (!buffer) {
      return
    }
    currentSegments.push({ text: buffer, color: currentColor })
    buffer = ''
  }

  function flushLine(): void {
    flushBuffer()
    lines.push({ key: `line-${lineIndex++}`, segments: currentSegments })
    currentSegments = []
  }

  for (const token of tokens as Array<{ type: string; code?: string; value?: string }>) {
    if (token.type === 'ansi') {
      flushBuffer()
      if (token.code === '[0m' || token.code === '[39m') {
        currentColor = undefined
      } else {
        currentColor = ansiCodeToInkColor(token.code ?? '') ?? currentColor
      }
      continue
    }

    const value = token.value ?? ''
    const parts = value.split('\n')
    parts.forEach((part, index) => {
      if (part) {
        buffer += part
      }
      if (index < parts.length - 1) {
        flushLine()
      }
    })
  }

  flushBuffer()
  if (currentSegments.length > 0 || lines.length === 0) {
    lines.push({ key: `line-${lineIndex}`, segments: currentSegments })
  }

  return lines
}
