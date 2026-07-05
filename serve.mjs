// Production launcher: `npm start`.
//
// `vite build` emits a web-fetch handler at dist/server/server.js (not a
// self-listening server) plus static client assets in dist/client. This wraps
// them in a plain node:http server so the app runs on any Node host: static
// files are served from dist/client, everything else (SSR + /api/*) is delegated
// to the built handler. Reads PORT/HOST from the environment.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'

const PORT = Number(process.env.PORT || 5173)
const HOST = process.env.HOST || '0.0.0.0'
const CLIENT_DIR = join(process.cwd(), 'dist', 'client')

const { default: handler } = await import('./dist/server/server.js')

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain',
}

async function resolveStatic(pathname) {
  // Only serve real files inside dist/client; block traversal.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(CLIENT_DIR, rel)
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + '/')) return null
  try {
    const s = await stat(filePath)
    return s.isFile() ? filePath : null
  } catch {
    return null
  }
}

function toWebRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v != null) headers.set(k, v)
  }
  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req)
    init.duplex = 'half'
  }
  return new Request(url, init)
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const file = await resolveStatic(pathname)
      if (file) {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        })
        if (req.method === 'HEAD') return res.end()
        return createReadStream(file).pipe(res)
      }
    }
    const response = await handler.fetch(toWebRequest(req))
    res.statusCode = response.status
    response.headers.forEach((v, k) => res.setHeader(k, v))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (err) {
    console.error('serve.mjs error:', err)
    res.statusCode = 500
    res.end('Internal Server Error')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`HomeIndexr listening on http://${HOST}:${PORT}`)
})
