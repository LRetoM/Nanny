import { STORAGE_KEY } from '../constants'
import type { LibraryImage, LibraryStore } from '../types'

const DEFAULT_STORE: LibraryStore = {
  version: 1,
  items: [],
}

export function loadLibraryStore(): LibraryStore {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return DEFAULT_STORE
  }

  try {
    const parsed = JSON.parse(raw) as LibraryStore
    if (!Array.isArray(parsed.items)) {
      return DEFAULT_STORE
    }
    return {
      version: 1,
      items: parsed.items.filter((item) => Boolean(item?.id && item?.sourceUrl)),
    }
  } catch {
    return DEFAULT_STORE
  }
}

export function saveLibraryStore(next: LibraryStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function upsertLibraryImage(image: LibraryImage): LibraryStore {
  const store = loadLibraryStore()
  const duplicate = store.items.find(
    (item) => item.category === image.category && item.sourceUrl === image.sourceUrl,
  )

  if (duplicate) {
    return store
  }

  const next: LibraryStore = {
    ...store,
    items: [image, ...store.items],
  }
  saveLibraryStore(next)
  return next
}

export function deleteLibraryImage(imageId: string): LibraryStore {
  const store = loadLibraryStore()
  const next: LibraryStore = {
    ...store,
    items: store.items.filter((item) => item.id !== imageId),
  }
  saveLibraryStore(next)
  return next
}

export function updateLibraryImage(updatedImage: LibraryImage): LibraryStore {
  const store = loadLibraryStore()
  const existingIndex = store.items.findIndex((item) => item.id === updatedImage.id)

  if (existingIndex < 0) {
    const next: LibraryStore = {
      ...store,
      items: [updatedImage, ...store.items],
    }
    saveLibraryStore(next)
    return next
  }

  const nextItems = [...store.items]
  nextItems[existingIndex] = updatedImage

  const next: LibraryStore = {
    ...store,
    items: nextItems,
  }
  saveLibraryStore(next)
  return next
}

export function clearLibrary(): LibraryStore {
  saveLibraryStore(DEFAULT_STORE)
  return DEFAULT_STORE
}

export function mergeLibraryImages(images: LibraryImage[]): LibraryStore {
  const store = loadLibraryStore()
  const uniqueByCategoryAndSource = new Set(store.items.map((item) => `${item.category}|${item.sourceUrl}`))
  const nextItems = [...store.items]

  for (const image of images) {
    const key = `${image.category}|${image.sourceUrl}`
    if (uniqueByCategoryAndSource.has(key)) {
      continue
    }
    uniqueByCategoryAndSource.add(key)
    nextItems.unshift(image)
  }

  const nextStore: LibraryStore = {
    ...store,
    items: nextItems,
  }
  saveLibraryStore(nextStore)
  return nextStore
}
