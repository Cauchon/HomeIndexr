import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: { port: 5173 },
  plugins: [tanstackStart(), viteReact()],
  // node-sqlite3-wasm loads its .wasm via readFileSync(__dirname + '/...wasm'),
  // so it must stay external (resolved from node_modules at runtime) rather than
  // bundled into the server output, or the .wasm path breaks after build.
  ssr: {
    external: ['node-sqlite3-wasm'],
  },
})
