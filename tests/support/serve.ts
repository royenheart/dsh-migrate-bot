import { createServer, type Server } from 'node:http'

/** Serve a `fetch`-shaped handler over HTTP on a free local port. */
export async function serve(handler: (request: Request) => Promise<Response>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      const request = new Request(`http://localhost${incoming.url ?? '/'}`, {
        method: incoming.method ?? 'GET',
        headers: incoming.headers as Record<string, string>,
        ...(body.length === 0 ? {} : { body }),
      })
      void handler(request).then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${String(port)}`, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) } }
}
