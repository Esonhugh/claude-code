// Spinner display mode — drives animation speed and glyph direction.
export type SpinnerMode =
  | 'requesting'
  | 'responding'
  | 'tool-input'
  | 'tool-use'
  | 'thinking'
  | (string & {})

// RGB color tuple used for spinner color interpolation.
export interface RGBColor {
  r: number
  g: number
  b: number
}
