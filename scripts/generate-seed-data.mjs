import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const assetsRoot = path.join(projectRoot, 'public', 'images', 'admin-assets')
const outputFile = path.join(projectRoot, 'src', 'lib', 'seedData.ts')
const metaFile = path.join(projectRoot, '.seed-data-meta.json')

const CATEGORY_CONFIG = [
  { id: 'eyes', label: 'Augen' },
  { id: 'eyebrows', label: 'Augenbrauen' },
  { id: 'nose', label: 'Nase' },
  { id: 'mouth', label: 'Mund' },
  { id: 'hair', label: 'Haare' },
  { id: 'ears', label: 'Ohren' },
  { id: 'accessories', label: 'Accessoire' },
]

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function escapeString(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function extractTimestamp(filename, stats) {
  const match = filename.match(/-(\d{13})(?=\.[^.]+$)/)
  if (match) {
    return Number(match[1])
  }
  return Math.round(stats.mtimeMs)
}

function extractId(filename) {
  const basename = filename.replace(/\.[^.]+$/, '')
  const timestampMatch = basename.match(/^(.*)-(\d{13})$/)
  if (timestampMatch) {
    return timestampMatch[1]
  }
  return basename
}

async function getImageDimensions(filePath) {
  const buffer = await fs.readFile(filePath)
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    }
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    let offset = 2
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)

      if (isStartOfFrame) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        }
      }

      offset += 2 + length
    }
    throw new Error(`Unsupported JPEG header: ${filePath}`)
  }

  if (extension === '.webp') {
    const chunkType = buffer.toString('ascii', 12, 16)
    if (chunkType === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (chunkType === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      }
    }
    if (chunkType === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
    throw new Error(`Unsupported WEBP header: ${filePath}`)
  }

  throw new Error(`Unsupported image extension: ${filePath}`)
}

async function loadMeta(currentVersion) {
  try {
    const raw = await fs.readFile(metaFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.version === 'number' && typeof parsed?.signature === 'string') {
      return parsed
    }
  } catch {
    // ignore
  }

  return {
    version: currentVersion,
    signature: '',
  }
}

async function readCurrentVersion() {
  try {
    const current = await fs.readFile(outputFile, 'utf8')
    const match = current.match(/export const SEED_VERSION = (\d+)/)
    if (match) {
      return Number(match[1])
    }
  } catch {
    // ignore
  }
  return 1
}

async function collectImages() {
  const images = []

  for (const category of CATEGORY_CONFIG) {
    const categoryDir = path.join(assetsRoot, category.id)
    let entries = []
    try {
      entries = await fs.readdir(categoryDir, { withFileTypes: true })
    } catch {
      continue
    }

    const files = entries
      .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)

    const items = []
    for (const file of files) {
      const absolutePath = path.join(categoryDir, file)
      const stats = await fs.stat(absolutePath)
      const createdAtMs = extractTimestamp(file, stats)
      const dimensions = await getImageDimensions(absolutePath)
      items.push({
        category: category.id,
        categoryLabel: category.label,
        file,
        id: extractId(file),
        relativeUrl: `/images/admin-assets/${category.id}/${file}`,
        width: dimensions.width,
        height: dimensions.height,
        createdAtMs,
        size: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
      })
    }

    items.sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) {
        return a.createdAtMs - b.createdAtMs
      }
      return a.file.localeCompare(b.file)
    })

    items.forEach((item, index) => {
      images.push({
        ...item,
        title: `${item.categoryLabel} ${index + 1}`,
      })
    })
  }

  return images
}

function buildSignature(images) {
  const hash = createHash('sha1')
  for (const image of images) {
    hash.update(
      [image.category, image.file, image.width, image.height, image.size, image.mtimeMs, image.createdAtMs].join('|'),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

function generateSeedFileContent(version, images) {
  const rows = images
    .map((image) => {
      return `  {\n    id: '${escapeString(image.id)}',\n    category: '${image.category}',\n    title: '${escapeString(image.title)}',\n    sourceUrl: '${image.relativeUrl}',\n    thumbUrl: '${image.relativeUrl}',\n    width: ${image.width},\n    height: ${image.height},\n    createdAt: new Date(${image.createdAtMs}).toISOString(),\n  },`
    })
    .join('\n')

  return `import type { LibraryImage } from '../types'\n\n// This file is auto-generated by scripts/generate-seed-data.mjs\n// Do not edit manually. Add or remove files under public/images/admin-assets instead.\nexport const SEED_VERSION = ${version}\n\nexport const SEED_IMAGES: LibraryImage[] = [\n${rows}\n]\n`
}

export async function generateSeedData() {
  const currentVersion = await readCurrentVersion()
  const meta = await loadMeta(currentVersion)
  const images = await collectImages()
  const signature = buildSignature(images)
  const nextVersion = meta.signature && meta.signature !== signature ? meta.version + 1 : meta.version
  const content = generateSeedFileContent(nextVersion, images)

  await fs.writeFile(outputFile, content, 'utf8')
  await fs.writeFile(metaFile, JSON.stringify({ version: nextVersion, signature }, null, 2) + '\n', 'utf8')

  return {
    version: nextVersion,
    count: images.length,
    changed: meta.signature !== signature,
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename
if (invokedDirectly) {
  try {
    const result = await generateSeedData()
    console.log(`Seed data generated: ${result.count} images, version ${result.version}${result.changed ? ' (updated)' : ''}`)
  } catch (error) {
    console.error('Failed to generate seed data')
    console.error(error)
    process.exitCode = 1
  }
}
