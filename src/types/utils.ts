export type DeepImmutable<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepImmutable<T[K]> : T[K]
}

export type Permutations<T extends string, U extends string = T> =
  T extends unknown ? T | `${T} ${Permutations<Exclude<U, T>>}` : never
