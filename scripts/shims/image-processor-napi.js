export function getNativeModule() {
  return null;
}

export function sharp() {
  throw new Error('Native image processor module not available');
}

export default sharp;
