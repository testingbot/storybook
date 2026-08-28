import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

/**
 * A static server for a built Storybook, used by the CLI's build-and-serve
 * mode.
 *
 * The alternative was to shell out to `npx serve` or `http-server`, which would
 * add a dependency the addon does not otherwise need and a process whose
 * readiness has to be polled for. This is forty lines and exits when we do.
 *
 * It binds every interface rather than loopback, for the same reason Storybook
 * does: a real device target has to be able to open it, and a device cannot
 * reach 127.0.0.1 on someone else's machine. See device-url.ts.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export type StaticServer = {
  url: string
  networkUrl: string | null
  close: () => Promise<void>
}

/** The same choice Storybook's getLocalIp makes, and it has to be, or the two disagree. */
export function localIp (): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }

  return null
}

export async function serveStatic (dir: string, port: number): Promise<StaticServer> {
  const root = path.resolve(dir)

  if (!fs.existsSync(path.join(root, 'index.json'))) {
    throw new Error(
      `${root} does not look like a built Storybook: it has no index.json. ` +
        'Build it first, or pass --url to point at one that is already served.',
    )
  }

  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
    const file = path.join(root, requested.endsWith('/') ? `${requested}index.html` : requested)

    // The request path is attacker-controlled in the sense that matters here:
    // it arrives over the network. Resolving and then checking containment is
    // the only reliable way to keep ../ from reading outside the build.
    const resolved = path.resolve(file)

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      response.writeHead(403).end('Forbidden')

      return
    }

    fs.readFile(resolved, (error, data) => {
      if (error) {
        response.writeHead(404).end('Not found')

        return
      }

      response.writeHead(200, { 'content-type': TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream' })
      response.end(data)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const ip = localIp()
  // The bound port, not the requested one. They differ when 0 was asked for,
  // and a URL that does not point at where we are listening is worse than no
  // URL at all: the runner would report every story as unreachable.
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port

  return {
    url: `http://localhost:${bound}`,
    networkUrl: ip ? `http://${ip}:${bound}` : null,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
