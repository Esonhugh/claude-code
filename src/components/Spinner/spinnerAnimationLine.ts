import { stringWidth } from '../../ink/stringWidth.js'

export type SpinnerAnimationLineInput = {
  columns: number
  message: string
  statusText: string
}

function sliceByWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let output = ''
  let width = 0
  for (const char of value) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth) break
    output += char
    width += charWidth
  }
  return output
}

function padToWidth(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - stringWidth(value)))
}

export function buildSpinnerAnimationLine({
  columns,
  message,
  statusText,
}: SpinnerAnimationLineInput): string {
  if (columns <= 0) return ''

  const normalizedStatus = statusText.trim()
  const statusWidth = stringWidth(normalizedStatus)
  const statusSegment =
    statusWidth >= columns
      ? sliceByWidth(normalizedStatus, columns)
      : normalizedStatus

  const reservedStatusWidth = stringWidth(statusSegment)
  const messageWidth = Math.max(0, columns - reservedStatusWidth)
  const visibleMessage = sliceByWidth(message, messageWidth)
  const gapWidth = Math.max(
    0,
    columns - stringWidth(visibleMessage) - reservedStatusWidth,
  )

  return padToWidth(
    `${visibleMessage}${' '.repeat(gapWidth)}${statusSegment}`,
    columns,
  )
}
