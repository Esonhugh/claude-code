// The website's interactive claude web demo: the real app with src/demo/mock.ts
// answering /api and the session socket. Built into site/dist/web-demo by site/build.ts.
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

export default mergeConfig(
  base,
  defineConfig({
    base: './',
    build: {
      outDir: '../site/dist/web-demo',
      emptyOutDir: true,
      rollupOptions: { input: { index: `${import.meta.dirname}/demo.html` } },
    },
  }),
)
