export function userType(): string {
  return 'external'
}

export function isAnt(): boolean {
  return userType() === 'ant'
}