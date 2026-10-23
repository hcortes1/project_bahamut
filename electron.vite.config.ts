import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Dev only: React Fast Refresh injects an inline preamble and HMR uses a
// websocket, so relax the CSP while serving. Never applied to builds.
const devCsp = (): Plugin => ({
  name: 'flujo-dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
      `$1default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'$2`
    )
  }
})

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // pdfjs-dist stays external (loaded from app.asar.unpacked at runtime); workers are separate entries
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'pdf-worker': resolve(__dirname, 'src/main/ingest/pdf/worker.ts'),
          'optimizer-worker': resolve(__dirname, 'src/main/analysis/optimizer/worker.ts')
        },
        external: ['pdfjs-dist', new RegExp('^pdfjs-dist/')]
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      // sandbox: true requires a single self-contained preload bundle
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), devCsp()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
