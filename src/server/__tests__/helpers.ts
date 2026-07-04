// Shared test isolation: point the SQLite path and .env at throwaway temp files
// BEFORE any connect() call. Path/env resolution is lazy per call, so setting
// these in a beforeEach works. Test DB isolation is mandatory (AGENTS.md).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let counter = 0

export function fresh_db(): string {
  counter += 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeindexr-test-'))
  const dbPath = path.join(dir, `test-${counter}.db`)
  process.env.HOMEINDEXR_DB_PATH = dbPath
  // A path that does not exist → dotenv_value() returns null for every key.
  process.env.HOMEINDEXR_DOTENV_PATH = path.join(dir, 'nonexistent.env')
  return dbPath
}
