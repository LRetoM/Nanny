import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const LOCAL_ASSET_PREFIX = '/images/admin-assets/'
const MAX_REQUEST_BODY_BYTES = 28 * 1024 * 1024
const execFileAsync = promisify(execFile)

interface SaveAssetPayload {
  category: string
  imageDataUrl: string
  imageId: string
  previousPath?: string | null
}

interface BulkDeletePayload {
  paths: string[]
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error('REQUEST_TOO_LARGE')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sanitizeSegment(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  return normalized || fallback
}

function mimeToExtension(mimeType: string): string | null {
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg'
  return null
}

function normalizeManagedPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return null
  }

  try {
    const parsed = new URL(candidate, 'http://localhost')
    const normalized = path.posix.normalize(parsed.pathname)
    if (!normalized.startsWith(LOCAL_ASSET_PREFIX)) {
      return null
    }
    if (normalized.includes('..')) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function toAbsoluteManagedPath(publicDir: string, managedRoot: string, managedPath: string): string | null {
  const absolutePath = path.resolve(publicDir, managedPath.slice(1))
  if (!absolutePath.startsWith(managedRoot)) {
    return null
  }
  return absolutePath
}

async function pruneEmptyManagedFolders(directory: string, managedRoot: string): Promise<void> {
  let current = directory
  while (current.startsWith(managedRoot) && current !== managedRoot) {
    const entries = await fs.readdir(current)
    if (entries.length > 0) {
      return
    }
    await fs.rmdir(current)
    current = path.dirname(current)
  }
}

async function deleteManagedFile(publicDir: string, managedRoot: string, managedPath: string): Promise<void> {
  const absoluteFilePath = toAbsoluteManagedPath(publicDir, managedRoot, managedPath)
  if (!absoluteFilePath) {
    return
  }

  try {
    await fs.unlink(absoluteFilePath)
    await pruneEmptyManagedFolders(path.dirname(absoluteFilePath), managedRoot)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }
}

async function runSeedGeneration(rootDir: string): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/generate-seed-data.mjs'], {
    cwd: rootDir,
  })
}

function createLocalAssetPlugin(): Plugin {
  const registerMiddleware = (
    rootDir: string,
    attachMiddleware: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void,
  ) => {
    const publicDir = path.resolve(rootDir, 'public')
    const managedRoot = path.resolve(publicDir, 'images', 'admin-assets')

    attachMiddleware(async (req, res, next) => {
      const requestPath = req.url?.split('?')[0]
      if (!requestPath) {
        next()
        return
      }

      const isSaveRoute = requestPath === '/api/admin/local-assets'
      const isBulkDeleteRoute = requestPath === '/api/admin/local-assets/bulk-delete'
      if (!isSaveRoute && !isBulkDeleteRoute) {
        next()
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }

      try {
        const body = await readJsonBody(req)

        if (isSaveRoute) {
          const payload = body as Partial<SaveAssetPayload>
          if (
            typeof payload.category !== 'string' ||
            typeof payload.imageDataUrl !== 'string' ||
            typeof payload.imageId !== 'string'
          ) {
            sendJson(res, 400, { error: 'Invalid payload' })
            return
          }

          const matchedDataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
            payload.imageDataUrl.trim(),
          )
          if (!matchedDataUrl) {
            sendJson(res, 400, { error: 'Unsupported image data' })
            return
          }

          const extension = mimeToExtension(matchedDataUrl[1])
          if (!extension) {
            sendJson(res, 415, { error: 'Unsupported image type' })
            return
          }

          const safeCategory = sanitizeSegment(payload.category, 'misc')
          const safeImageId = sanitizeSegment(payload.imageId, 'asset')
          const categoryDirectory = path.join(managedRoot, safeCategory)
          await fs.mkdir(categoryDirectory, { recursive: true })

          const filename = `${safeImageId}-${Date.now()}.${extension}`
          const absoluteOutputPath = path.join(categoryDirectory, filename)
          await fs.writeFile(absoluteOutputPath, Buffer.from(matchedDataUrl[2], 'base64'))

          const previousManagedPath = normalizeManagedPath(payload.previousPath)
          if (previousManagedPath) {
            await deleteManagedFile(publicDir, managedRoot, previousManagedPath)
          }

          await runSeedGeneration(rootDir)

          sendJson(res, 200, {
            url: `${LOCAL_ASSET_PREFIX}${safeCategory}/${filename}`,
          })
          return
        }

        const payload = body as Partial<BulkDeletePayload>
        if (!Array.isArray(payload.paths)) {
          sendJson(res, 400, { error: 'Invalid payload' })
          return
        }

        let deletedCount = 0
        for (const entry of payload.paths) {
          const managedPath = normalizeManagedPath(entry)
          if (!managedPath) {
            continue
          }
          await deleteManagedFile(publicDir, managedRoot, managedPath)
          deletedCount += 1
        }

        await runSeedGeneration(rootDir)

        sendJson(res, 200, { deleted: deletedCount })
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
          sendJson(res, 413, { error: 'Payload too large' })
          return
        }

        sendJson(res, 500, { error: 'Local asset request failed' })
      }
    })
  }

  return {
    name: 'local-admin-asset-storage',
    async buildStart() {
      await runSeedGeneration(process.cwd())
    },
    configureServer(server) {
      void runSeedGeneration(server.config.root)
      registerMiddleware(server.config.root, server.middlewares.use.bind(server.middlewares))
    },
    configurePreviewServer(server) {
      void runSeedGeneration(server.config.root)
      registerMiddleware(server.config.root, server.middlewares.use.bind(server.middlewares))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), createLocalAssetPlugin()],
})
