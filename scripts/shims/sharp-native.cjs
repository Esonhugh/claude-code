module.exports = new Proxy({}, {
  get(_target, property) {
    const nativeModule = globalThis.__CLAUDE_CODE_SHARP_NATIVE__;
    if (!nativeModule) {
      throw new Error('Embedded sharp native module was not loaded');
    }
    return nativeModule[property];
  },
});
