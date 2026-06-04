export interface SecureStorageData {
  [key: string]: string | undefined
}

export interface SecureStorage {
  name?: string
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key?: string): Promise<void>
  read(key: string): string | undefined
  readAsync?(key: string): Promise<string | undefined>
  update(key: string, value: string): void
  getAll?(): Promise<SecureStorageData>
  [key: string]: unknown
}
