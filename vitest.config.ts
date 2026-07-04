// Separate config so vitest doesn't load the TanStack Start plugin from vite.config.ts.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/server/__tests__/**/*.test.ts'],
  },
})
