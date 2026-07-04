// Secrets/config resolution — ported from the _dotenv_* helpers in
// backend/app/store.py. Keys come from the process environment or an ignored
// local .env, never SQLite (AGENTS.md rule #13).

import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './db'

function dotenv_path(): string {
  return process.env.HOMEINDEXR_DOTENV_PATH || path.join(ROOT, '.env')
}

export function dotenv_value(name: string): string | null {
  let lines: string[]
  try {
    lines = fs.readFileSync(dotenv_path(), 'utf-8').split(/\r?\n/)
  } catch {
    return null
  }
  for (const line of lines) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#') || !stripped.includes('=')) continue
    const idx = stripped.indexOf('=')
    const key = stripped.slice(0, idx)
    let value = stripped.slice(idx + 1)
    if (key.trim() !== name) continue
    value = value.trim().replace(/^["']+|["']+$/g, '')
    return value || null
  }
  return null
}

export function get_env(name: string): string | undefined {
  return process.env[name] || dotenv_value(name) || undefined
}
