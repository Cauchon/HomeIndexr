import { createFileRoute } from '@tanstack/react-router'
import { App } from '../app/app'
import '../app/styles.css'

// The whole legacy SPA (hash router and all) mounts client-only here — its code
// touches window/localStorage at render time, so it must never run on the server.
export const Route = createFileRoute('/')({
  ssr: false,
  component: App,
})
