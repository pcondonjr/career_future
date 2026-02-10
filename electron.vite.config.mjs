import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: 'src/main/index.js',
        output: {
          format: 'es'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: 'src/preload/preload.js'
      }
    }
  },
  renderer: {
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          error: 'src/renderer/error.html',
          wizard: 'src/renderer/wizard.html'
        }
      }
    }
  }
});
