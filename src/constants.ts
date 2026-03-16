import type { HeadShapeId } from './types'
import type { AssetCategory } from './types'

interface NormalizedPoint {
  x: number
  y: number
}

export interface HeadShapeTemplate {
  id: HeadShapeId
  label: string
  imageUrl: string
  contour: NormalizedPoint[]
  maskContour?: NormalizedPoint[]
}

export const STORAGE_KEY = 'kids-face-collage-library-v1'
export const STUDIO_DOC_STORAGE_KEY = 'kids-face-collage-studio-doc-v1'

export const DEFAULT_STAGE_WIDTH = 980
export const DEFAULT_STAGE_HEIGHT = 680

export const HEAD_AREA = {
  x: 220,
  y: 70,
  width: 540,
  height: 560,
}

export const HEAD_SHAPES: HeadShapeTemplate[] = [
  {
    id: 'maleClassic',
    label: 'Kopf 1',
    imageUrl: '/images/Kopf.png',
    contour: [
      { x: 0.30, y: 0.96 },
      { x: 0.30, y: 0.80 },
      { x: 0.23, y: 0.73 },
      { x: 0.19, y: 0.65 },
      { x: 0.17, y: 0.56 },
      { x: 0.16, y: 0.47 },
      { x: 0.18, y: 0.38 },
      { x: 0.24, y: 0.24 },
      { x: 0.35, y: 0.14 },
      { x: 0.50, y: 0.10 },
      { x: 0.65, y: 0.14 },
      { x: 0.76, y: 0.24 },
      { x: 0.82, y: 0.38 },
      { x: 0.84, y: 0.47 },
      { x: 0.83, y: 0.56 },
      { x: 0.81, y: 0.65 },
      { x: 0.77, y: 0.73 },
      { x: 0.70, y: 0.80 },
      { x: 0.70, y: 0.96 },
    ],
  },
  {
    id: 'femaleSoft',
    label: 'Kopf 2',
    imageUrl: '/images/kopf1.jpg',
    contour: [
      { x: 0.32, y: 0.96 },
      { x: 0.32, y: 0.84 },
      { x: 0.24, y: 0.80 },
      { x: 0.16, y: 0.69 },
      { x: 0.13, y: 0.54 },
      { x: 0.13, y: 0.38 },
      { x: 0.18, y: 0.24 },
      { x: 0.30, y: 0.13 },
      { x: 0.50, y: 0.08 },
      { x: 0.70, y: 0.13 },
      { x: 0.82, y: 0.24 },
      { x: 0.87, y: 0.38 },
      { x: 0.87, y: 0.54 },
      { x: 0.84, y: 0.69 },
      { x: 0.76, y: 0.80 },
      { x: 0.68, y: 0.84 },
      { x: 0.68, y: 0.96 },
    ],
  },
  {
    id: 'maleAngular',
    label: 'Kopf 3',
    imageUrl: '/images/Kopf3.png',
    contour: [
      { x: 0.29, y: 0.96 },
      { x: 0.29, y: 0.79 },
      { x: 0.23, y: 0.75 },
      { x: 0.19, y: 0.68 },
      { x: 0.16, y: 0.58 },
      { x: 0.14, y: 0.48 },
      { x: 0.15, y: 0.37 },
      { x: 0.22, y: 0.25 },
      { x: 0.34, y: 0.15 },
      { x: 0.50, y: 0.11 },
      { x: 0.66, y: 0.15 },
      { x: 0.78, y: 0.25 },
      { x: 0.85, y: 0.37 },
      { x: 0.86, y: 0.48 },
      { x: 0.84, y: 0.58 },
      { x: 0.81, y: 0.68 },
      { x: 0.77, y: 0.75 },
      { x: 0.71, y: 0.79 },
      { x: 0.71, y: 0.96 },
    ],
  },
]

export const QUICK_SEARCH_TERMS = [
  'eyes portrait',
  'nose portrait',
  'mouth portrait',
  'hair portrait',
  'face side portrait',
  'fashion glasses',
  'hat portrait',
]

export const STARTER_SEARCH_TERMS: Record<AssetCategory, string[]> = {
  eyes: ['portrait eyes close up', 'human eye closeup'],
  eyebrows: ['portrait eyebrow detail', 'face brow closeup'],
  nose: ['portrait nose close up', 'face profile nose'],
  mouth: ['portrait lips closeup', 'smile mouth closeup'],
  hair: ['portrait hairstyle', 'curly hair portrait'],
  ears: ['portrait ear closeup', 'side profile portrait'],
  accessories: ['portrait glasses hat', 'fashion accessory portrait'],
}
