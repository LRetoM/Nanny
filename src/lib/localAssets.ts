import type { AssetCategory } from '../types'

const LOCAL_ASSET_PREFIX = '/images/admin-assets/'

interface SaveLocalAssetPayload {
  category: AssetCategory
  imageDataUrl: string
  imageId: string
  previousPath?: string | null
}

interface SaveLocalAssetResponse {
  url: string
}

function assertResponseOk(response: Response): void {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
}

export function getManagedLocalAssetPath(url: string): string | null {
  try {
    const parsedUrl = new URL(url, window.location.origin)
    if (!parsedUrl.pathname.startsWith(LOCAL_ASSET_PREFIX)) {
      return null
    }
    return parsedUrl.pathname
  } catch {
    return null
  }
}

export async function saveLocalAdminAsset(payload: SaveLocalAssetPayload): Promise<string> {
  const response = await fetch('/api/admin/local-assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  assertResponseOk(response)
  const result = (await response.json()) as SaveLocalAssetResponse
  if (!result?.url) {
    throw new Error('Keine lokale Datei-URL erhalten')
  }
  return result.url
}

export async function deleteLocalAdminAssets(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return
  }
  const response = await fetch('/api/admin/local-assets/bulk-delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paths }),
  })
  assertResponseOk(response)
}
