export interface TipContext {
  [key: string]: unknown
}

export interface Tip {
  id: string
  title: string
  message: string
  condition?: (ctx: TipContext) => boolean
  [key: string]: unknown
}
