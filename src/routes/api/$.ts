import { createFileRoute } from '@tanstack/react-router'
import { handle_api } from '../../server/api'

const handler = ({ request }: { request: Request }) => handle_api(request)

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PATCH: handler,
      DELETE: handler,
      OPTIONS: handler,
    },
  },
})
