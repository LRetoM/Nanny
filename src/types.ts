export const CATEGORIES = [
  { id: 'eyes', label: 'Augen', icon: 'o o', iconImageUrl: '/images/icon-eyes.svg' },
  { id: 'eyebrows', label: 'Augenbrauen', icon: '^^', iconImageUrl: '/images/icon-eyebrows.svg' },
  { id: 'nose', label: 'Nase', icon: '^', iconImageUrl: '/images/icon-nose.svg' },
  { id: 'mouth', label: 'Mund', icon: ')', iconImageUrl: '/images/icon-mouth.svg' },
  { id: 'hair', label: 'Haare', icon: '~', iconImageUrl: '/images/icon-hair.svg' },
  { id: 'ears', label: 'Ohren', icon: '()', iconImageUrl: '/images/icon-ears.svg' },
  { id: 'accessories', label: 'Accessoires', icon: '*', iconImageUrl: '/images/icon-accessories.svg' },
] as const

export type AssetCategory = (typeof CATEGORIES)[number]['id']

export type HeadShapeId = 'maleClassic' | 'femaleSoft' | 'maleAngular'

export type ToolMode = 'hand' | 'scissors'

export interface LibraryImage {
  id: string
  category: AssetCategory
  title: string
  sourceUrl: string
  thumbUrl: string
  sourcePage?: string
  author?: string
  licenseName?: string
  licenseUrl?: string
  width: number
  height: number
  createdAt: string
}

export interface LibraryStore {
  version: number
  items: LibraryImage[]
}

export interface SearchImageResult {
  title: string
  sourceUrl: string
  thumbUrl: string
  sourcePage?: string
  author?: string
  licenseName?: string
  licenseUrl?: string
  width: number
  height: number
}

export interface StudioPiece {
  id: string
  imageId: string
  category: AssetCategory
  title: string
  imageUrl: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  rotation?: number
  clipPoints?: number[]
}

export interface StudioDoc {
  headShape: HeadShapeId
  pieces: StudioPiece[]
}
