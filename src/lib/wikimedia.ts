import type { SearchImageResult } from '../types'

interface WikimediaQueryPage {
  title?: string
  fullurl?: string
  imageinfo?: Array<{
    url?: string
    thumburl?: string
    width?: number
    height?: number
    extmetadata?: Record<string, { value?: string }>
  }>
}

interface WikimediaResponse {
  query?: {
    pages?: Record<string, WikimediaQueryPage>
  }
}

function stripHtml(input?: string): string | undefined {
  if (!input) {
    return undefined
  }
  return input.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

export async function searchWikimediaCommons(query: string): Promise<SearchImageResult[]> {
  const normalized = query.trim()
  if (!normalized) {
    return []
  }

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: '36',
    gsrsearch: `${normalized} filetype:bitmap`,
    prop: 'imageinfo|info',
    inprop: 'url',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '500',
  })

  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`)
  if (!response.ok) {
    throw new Error('Bildsuche fehlgeschlagen.')
  }

  const payload = (await response.json()) as WikimediaResponse
  const pages = payload.query?.pages ? Object.values(payload.query.pages) : []

  return pages
    .map((page) => {
      const imageInfo = page.imageinfo?.[0]
      if (!imageInfo?.url) {
        return null
      }

      const metadata = imageInfo.extmetadata ?? {}
      const title = (page.title ?? 'Unbenanntes Bild').replace(/^File:/, '')

      const result: SearchImageResult = {
        title,
        sourceUrl: imageInfo.url,
        thumbUrl: imageInfo.thumburl ?? imageInfo.url,
        width: Number(imageInfo.width ?? 1200),
        height: Number(imageInfo.height ?? 1200),
      }

      const sourcePage = page.fullurl
      if (sourcePage) {
        result.sourcePage = sourcePage
      }

      const author = stripHtml(metadata.Artist?.value)
      if (author) {
        result.author = author
      }

      const licenseName = stripHtml(metadata.LicenseShortName?.value)
      if (licenseName) {
        result.licenseName = licenseName
      }

      const licenseUrl = stripHtml(metadata.LicenseUrl?.value)
      if (licenseUrl) {
        result.licenseUrl = licenseUrl
      }

      return result
    })
    .filter((entry): entry is SearchImageResult => entry !== null)
}
