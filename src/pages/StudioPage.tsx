import { useEffect, useMemo, useRef, useState } from 'react'
import type { Group as KonvaGroup } from 'konva/lib/Group'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Stage as KonvaStage } from 'konva/lib/Stage'
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer'
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from 'react-konva'
import {
  CATEGORIES,
  type AssetCategory,
  type HeadShapeId,
  type LibraryImage,
  type LibraryStore,
  type StudioDoc,
  type StudioPiece,
  type ToolMode,
} from '../types'
import { DEFAULT_STAGE_HEIGHT, DEFAULT_STAGE_WIDTH, HEAD_SHAPES, STUDIO_DOC_STORAGE_KEY } from '../constants'
import { loadLibraryStore } from '../lib/storage'
import { useLoadedImage } from '../hooks/useLoadedImage'

interface Point {
  x: number
  y: number
}

interface Camera {
  x: number
  y: number
  scale: number
}

interface HistoryState {
  doc: StudioDoc
  past: StudioDoc[]
  future: StudioDoc[]
}

interface PieceNodeProps {
  piece: StudioPiece
  selected: boolean
  showSelection: boolean
  tool: ToolMode
  assignRef: (pieceId: string, node: KonvaGroup | null) => void
  onSelect: (pieceId: string) => void
  onDragEnd: (pieceId: string, x: number, y: number) => void
  onTransformEnd: (pieceId: string, x: number, y: number, scale: number, rotation: number) => void
  onDelete: (pieceId: string) => void
  onMoveLayerUp: (pieceId: string) => void
  onMoveLayerDown: (pieceId: string) => void
  canMoveLayerUp: boolean
  canMoveLayerDown: boolean
}

const INITIAL_DOC: StudioDoc = {
  headShape: 'maleClassic',
  pieces: [],
}

const INITIAL_HISTORY_STATE: HistoryState = {
  doc: INITIAL_DOC,
  past: [],
  future: [],
}

const PIECE_OFFSETS: Point[] = [
  { x: -30, y: -22 },
  { x: 26, y: -16 },
  { x: -18, y: 24 },
  { x: 22, y: 18 },
  { x: 0, y: -28 },
]

const SCISSOR_CLOSE_DISTANCE_MOUSE = 34
const SCISSOR_CLOSE_DISTANCE_TOUCH = 56
const TABLET_BREAKPOINT = 1180
const FIXED_TABLET_STAGE = {
  width: 720,
  height: 520,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function flattenPoints(points: Point[]): number[] {
  return points.flatMap((point) => [point.x, point.y])
}

function cloneDoc(doc: StudioDoc): StudioDoc {
  return structuredClone(doc)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeHeadShape(value: unknown): HeadShapeId {
  if (typeof value === 'string') {
    if (HEAD_SHAPES.some((shape) => shape.id === value)) {
      return value as HeadShapeId
    }
    if (value === 'oval' || value === 'round' || value === 'square') {
      return 'maleClassic'
    }
  }
  return 'maleClassic'
}

function parseStoredStudioDoc(): StudioDoc | null {
  const raw = localStorage.getItem(STUDIO_DOC_STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StudioDoc>
    if (!parsed) {
      return null
    }
    if (!Array.isArray(parsed.pieces)) {
      return null
    }

    const normalizedPieces = parsed.pieces.filter((piece): piece is StudioPiece => {
      return (
        typeof piece?.id === 'string' &&
        typeof piece.imageId === 'string' &&
        typeof piece.imageUrl === 'string' &&
        typeof piece.category === 'string' &&
        typeof piece.title === 'string' &&
        isFiniteNumber(piece.x) &&
        isFiniteNumber(piece.y) &&
        isFiniteNumber(piece.width) &&
        isFiniteNumber(piece.height) &&
        isFiniteNumber(piece.scale)
      )
    })

    const piecesWithRotation = normalizedPieces.map((piece) => ({
      ...piece,
      rotation: isFiniteNumber(piece.rotation) ? piece.rotation : 0,
    }))

    return {
      headShape: normalizeHeadShape(parsed.headShape),
      pieces: piecesWithRotation,
    }
  } catch {
    return null
  }
}

function isScissorCloseEnough(points: Point[], cameraScale: number, closeDistancePx: number): boolean {
  if (points.length < 3) {
    return false
  }
  const first = points[0]
  const last = points[points.length - 1]
  const distanceInScreenPixels = distance(first, last) * cameraScale
  return distanceInScreenPixels <= closeDistancePx
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isInsidePiece(point: Point, piece: StudioPiece): boolean {
  const radians = -((piece.rotation ?? 0) * Math.PI) / 180
  const translatedX = point.x - piece.x
  const translatedY = point.y - piece.y
  const rotatedX = translatedX * Math.cos(radians) - translatedY * Math.sin(radians)
  const rotatedY = translatedX * Math.sin(radians) + translatedY * Math.cos(radians)
  const localX = rotatedX / piece.scale
  const localY = rotatedY / piece.scale
  return localX >= 0 && localX <= piece.width && localY >= 0 && localY <= piece.height
}

function getHeadShapeTemplate(shape: HeadShapeId) {
  return HEAD_SHAPES.find((entry) => entry.id === shape) ?? HEAD_SHAPES[0]
}

function scaleTemplatePoints(
  points: Array<{ x: number; y: number }>,
  area: { x: number; y: number; width: number; height: number },
): Point[] {
  return points.map((point) => ({
    x: area.x + point.x * area.width,
    y: area.y + point.y * area.height,
  }))
}

function drawPathFromPoints(context: CanvasRenderingContext2D, points: Point[]): void {
  if (points.length < 3) {
    return
  }
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y)
  }
  context.closePath()
}

function drawPathFromFlatPoints(context: CanvasRenderingContext2D, points: number[]): void {
  if (points.length < 6) {
    return
  }
  context.beginPath()
  context.moveTo(points[0], points[1])
  for (let index = 2; index < points.length; index += 2) {
    context.lineTo(points[index], points[index + 1])
  }
  context.closePath()
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Bild konnte nicht geladen werden'))
    image.src = url
  })
}

function renderPieceToCanvas(image: HTMLImageElement, piece: StudioPiece): HTMLCanvasElement {
  const width = Math.max(1, Math.round(piece.width))
  const height = Math.max(1, Math.round(piece.height))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')

  if (!context) {
    return canvas
  }

  context.clearRect(0, 0, width, height)
  context.save()
  if (piece.clipPoints && piece.clipPoints.length >= 6) {
    drawPathFromFlatPoints(context, piece.clipPoints)
    context.clip()
  }
  context.drawImage(image, 0, 0, width, height)
  context.restore()
  return canvas
}

function cropCanvasToOpaquePixels(source: HTMLCanvasElement): { canvas: HTMLCanvasElement; offsetX: number; offsetY: number } | null {
  const context = source.getContext('2d')
  if (!context) {
    return null
  }

  const { width, height } = source
  const imageData = context.getImageData(0, 0, width, height).data

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = imageData[(y * width + x) * 4 + 3]
      if (alpha > 6) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return null
  }

  const croppedCanvas = document.createElement('canvas')
  croppedCanvas.width = maxX - minX + 1
  croppedCanvas.height = maxY - minY + 1
  const croppedContext = croppedCanvas.getContext('2d')
  if (!croppedContext) {
    return null
  }

  croppedContext.drawImage(
    source,
    minX,
    minY,
    croppedCanvas.width,
    croppedCanvas.height,
    0,
    0,
    croppedCanvas.width,
    croppedCanvas.height,
  )

  return { canvas: croppedCanvas, offsetX: minX, offsetY: minY }
}

function findTopPieceAtPoint(pieces: StudioPiece[], point: Point): StudioPiece | null {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    if (isInsidePiece(point, pieces[index])) {
      return pieces[index]
    }
  }
  return null
}

function PieceNode({
  piece,
  selected,
  showSelection,
  tool,
  assignRef,
  onSelect,
  onDragEnd,
  onTransformEnd,
  onDelete,
  onMoveLayerUp,
  onMoveLayerDown,
  canMoveLayerUp,
  canMoveLayerDown,
}: PieceNodeProps) {
  const image = useLoadedImage(piece.imageUrl)
  const trashIcon = useLoadedImage('/images/tool-trash.svg')
  const clipPoints = piece.clipPoints ?? []
  const BTN = 36
  const GAP = 6
  const CONTROL_GAP = 6
  const controlsWidth = BTN * 2 + CONTROL_GAP

  return (
    <Group
      ref={(node) => {
        assignRef(piece.id, node)
      }}
      x={piece.x}
      y={piece.y}
      scaleX={piece.scale}
      scaleY={piece.scale}
      rotation={piece.rotation ?? 0}
      draggable={tool === 'hand'}
      onPointerDown={(event) => {
        if (tool === 'hand') {
          event.cancelBubble = true
          onSelect(piece.id)
        }
      }}
      onTap={(event) => {
        if (tool === 'hand') {
          event.cancelBubble = true
          onSelect(piece.id)
        }
      }}
      onTransformEnd={(event) => {
        const node = event.target
        onTransformEnd(piece.id, node.x(), node.y(), clamp(node.scaleX(), 0.05, 1.5), node.rotation())
      }}
      onDragEnd={(event) => {
        onDragEnd(piece.id, event.target.x(), event.target.y())
      }}
    >
      <Group
        clipFunc={
          clipPoints.length >= 6
            ? (context) => {
                context.beginPath()
                context.moveTo(clipPoints[0], clipPoints[1])
                for (let index = 2; index < clipPoints.length; index += 2) {
                  context.lineTo(clipPoints[index], clipPoints[index + 1])
                }
                context.closePath()
              }
            : undefined
        }
      >
        {image ? <KonvaImage image={image} width={piece.width} height={piece.height} /> : null}
      </Group>
      {selected && showSelection ? (
        <>
          <Rect
            width={piece.width}
            height={piece.height}
            stroke="#00997a"
            strokeWidth={2}
            dash={[8, 6]}
            strokeScaleEnabled={false}
          />
          {tool === 'hand' ? (
            <>
              <Group
                x={piece.width / 2 - controlsWidth / (2 * piece.scale)}
                y={-(BTN + GAP) / piece.scale}
                scaleX={1 / piece.scale}
                scaleY={1 / piece.scale}
                onPointerDown={(event) => {
                  event.cancelBubble = true
                }}
              >
                <Group
                  onClick={(event) => {
                    event.cancelBubble = true
                    onMoveLayerUp(piece.id)
                  }}
                  onTap={(event) => {
                    event.cancelBubble = true
                    onMoveLayerUp(piece.id)
                  }}
                >
                  <Rect
                    width={BTN}
                    height={BTN}
                    cornerRadius={10}
                    fill={canMoveLayerUp ? '#eef7ff' : '#f1f1f1'}
                    stroke={canMoveLayerUp ? '#2d7db6' : '#b9b9b9'}
                    strokeWidth={2}
                    shadowColor="#275676"
                    shadowBlur={6}
                    shadowOpacity={0.18}
                  />
                  <Text text="↑" x={12} y={3} fontSize={26} fill={canMoveLayerUp ? '#245f8a' : '#8d8d8d'} />
                </Group>
                <Group
                  x={BTN + CONTROL_GAP}
                  onClick={(event) => {
                    event.cancelBubble = true
                    onMoveLayerDown(piece.id)
                  }}
                  onTap={(event) => {
                    event.cancelBubble = true
                    onMoveLayerDown(piece.id)
                  }}
                >
                  <Rect
                    width={BTN}
                    height={BTN}
                    cornerRadius={10}
                    fill={canMoveLayerDown ? '#eef7ff' : '#f1f1f1'}
                    stroke={canMoveLayerDown ? '#2d7db6' : '#b9b9b9'}
                    strokeWidth={2}
                    shadowColor="#275676"
                    shadowBlur={6}
                    shadowOpacity={0.18}
                  />
                  <Text text="↓" x={12} y={3} fontSize={26} fill={canMoveLayerDown ? '#245f8a' : '#8d8d8d'} />
                </Group>
              </Group>

              <Group
                x={piece.width + GAP / piece.scale}
                y={-(BTN + GAP) / piece.scale}
                scaleX={1 / piece.scale}
                scaleY={1 / piece.scale}
                onPointerDown={(event) => {
                  event.cancelBubble = true
                }}
                onClick={(event) => {
                  event.cancelBubble = true
                  onDelete(piece.id)
                }}
                onTap={(event) => {
                  event.cancelBubble = true
                  onDelete(piece.id)
                }}
              >
                <Rect
                  width={BTN}
                  height={BTN}
                  cornerRadius={10}
                  fill="#fff2ef"
                  stroke="#cc4e3a"
                  strokeWidth={2}
                  shadowColor="#7f1f10"
                  shadowBlur={8}
                  shadowOpacity={0.25}
                />
                {trashIcon ? (
                  <KonvaImage image={trashIcon} x={4} y={4} width={28} height={28} />
                ) : (
                  <Text text="🗑" x={5} y={4} fontSize={26} />
                )}
              </Group>
            </>
          ) : null}
        </>
      ) : null}
    </Group>
  )
}

function HeadGuide({ shapeId, area }: { shapeId: HeadShapeId; area: { x: number; y: number; width: number; height: number } }) {
  const template = getHeadShapeTemplate(shapeId)
  const image = useLoadedImage(template.imageUrl)

  if (image) {
    return (
      <KonvaImage
        x={area.x}
        y={area.y}
        width={area.width}
        height={area.height}
        image={image}
        listening={false}
      />
    )
  }

  const points = scaleTemplatePoints(template.contour, area).flatMap((point) => [point.x, point.y])
  return (
    <Line
      points={points}
      stroke="#121212"
      strokeWidth={6}
      lineCap="round"
      lineJoin="round"
      tension={0.25}
      listening={false}
    />
  )
}

function toWorldPoint(stage: KonvaStage, camera: Camera): Point | null {
  const pointer = stage.getPointerPosition()
  if (!pointer) {
    return null
  }
  return {
    x: (pointer.x - camera.x) / camera.scale,
    y: (pointer.y - camera.y) / camera.scale,
  }
}

export function StudioPage() {
  const stageRef = useRef<KonvaStage | null>(null)
  const transformerRef = useRef<KonvaTransformer | null>(null)
  const pieceNodeRefs = useRef<Record<string, KonvaGroup | null>>({})
  const stageContainerRef = useRef<HTMLDivElement | null>(null)
  const scissorCloseDistanceRef = useRef<number>(SCISSOR_CLOSE_DISTANCE_MOUSE)
  const currentDocRef = useRef<StudioDoc>(INITIAL_DOC)
  const isCutProcessingRef = useRef(false)
  const undoRef = useRef<() => void>(() => undefined)
  const redoRef = useRef<() => void>(() => undefined)
  const deleteSelectedPieceRef = useRef<() => void>(() => undefined)
  const cancelScissorDrawRef = useRef<(message?: string) => void>(() => undefined)
  const selectedPieceIdRef = useRef<string | null>(null)
  const isDrawingScissorRef = useRef(false)
  const stageSizeRef = useRef({ width: DEFAULT_STAGE_WIDTH, height: DEFAULT_STAGE_HEIGHT })

  const [libraryStore, setLibraryStore] = useState<LibraryStore>(() => loadLibraryStore())
  const [activeCategory, setActiveCategory] = useState<AssetCategory>(CATEGORIES[0].id)
  const [tool, setTool] = useState<ToolMode>('hand')
  const [historyState, setHistoryState] = useState<HistoryState>(() => {
    const storedDoc = parseStoredStudioDoc()
    if (!storedDoc) {
      return INITIAL_HISTORY_STATE
    }
    return {
      doc: storedDoc,
      past: [],
      future: [],
    }
  })
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  const [stageSize, setStageSize] = useState({ width: DEFAULT_STAGE_WIDTH, height: DEFAULT_STAGE_HEIGHT })
  const [scissorPoints, setScissorPoints] = useState<Point[]>([])
  const [isDrawingScissor, setIsDrawingScissor] = useState(false)
  const [cutTargetPieceId, setCutTargetPieceId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isExportingImage, setIsExportingImage] = useState(false)

  const headArea = useMemo(() => {
    return {
      x: stageSize.width * 0.22,
      y: stageSize.height * 0.08,
      width: stageSize.width * 0.56,
      height: stageSize.height * 0.84,
    }
  }, [stageSize.height, stageSize.width])

  const effectiveSelectedPieceId = useMemo(() => {
    if (!selectedPieceId) {
      return null
    }
    const exists = historyState.doc.pieces.some((piece) => piece.id === selectedPieceId)
    return exists ? selectedPieceId : null
  }, [historyState.doc.pieces, selectedPieceId])

  const selectedPiece = useMemo(
    () => historyState.doc.pieces.find((piece) => piece.id === effectiveSelectedPieceId) ?? null,
    [effectiveSelectedPieceId, historyState.doc.pieces],
  )

  const selectedPieceIndex = useMemo(
    () => historyState.doc.pieces.findIndex((piece) => piece.id === effectiveSelectedPieceId),
    [effectiveSelectedPieceId, historyState.doc.pieces],
  )

  const scissorCanClose = useMemo(
    () => isScissorCloseEnough(scissorPoints, camera.scale, scissorCloseDistanceRef.current),
    [camera.scale, scissorPoints],
  )
  const scissorStartPoint = scissorPoints.length > 0 ? scissorPoints[0] : null
  const scissorLastPoint = scissorPoints.length > 0 ? scissorPoints[scissorPoints.length - 1] : null

  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) {
      return
    }

    if (tool !== 'hand' || !effectiveSelectedPieceId || isExportingImage) {
      transformer.nodes([])
      transformer.getLayer()?.batchDraw()
      return
    }

    const node = pieceNodeRefs.current[effectiveSelectedPieceId]
    if (!node) {
      transformer.nodes([])
      transformer.getLayer()?.batchDraw()
      return
    }

    transformer.nodes([node])
    transformer.getLayer()?.batchDraw()
  }, [effectiveSelectedPieceId, historyState.doc.pieces, isExportingImage, tool])

  useEffect(() => {
    currentDocRef.current = historyState.doc
    try {
      localStorage.setItem(STUDIO_DOC_STORAGE_KEY, JSON.stringify(historyState.doc))
    } catch {
      // Ignore storage quota errors; editing should continue in memory.
    }
  }, [historyState.doc])

  const commitDoc = (updater: (doc: StudioDoc) => StudioDoc) => {
    setHistoryState((previous) => {
      const nextDoc = updater(previous.doc)
      return {
        doc: nextDoc,
        past: [...previous.past, cloneDoc(previous.doc)],
        future: [],
      }
    })
  }

  const undo = () => {
    setHistoryState((previous) => {
      if (previous.past.length === 0) {
        return previous
      }
      const nextPast = [...previous.past]
      const restoredDoc = nextPast.pop()
      if (!restoredDoc) {
        return previous
      }

      return {
        doc: cloneDoc(restoredDoc),
        past: nextPast,
        future: [cloneDoc(previous.doc), ...previous.future],
      }
    })
  }

  const redo = () => {
    setHistoryState((previous) => {
      if (previous.future.length === 0) {
        return previous
      }
      const [restored, ...restFuture] = previous.future
      return {
        doc: cloneDoc(restored),
        past: [...previous.past, cloneDoc(previous.doc)],
        future: restFuture,
      }
    })
  }

  useEffect(() => {
    const syncLibrary = () => {
      setLibraryStore(loadLibraryStore())
    }

    const syncStageSize = () => {
      const container = stageContainerRef.current
      if (!container) {
        return
      }
      if (window.innerWidth <= TABLET_BREAKPOINT) {
        setStageSize(FIXED_TABLET_STAGE)
        return
      }

      const nextWidth = Math.max(640, Math.floor(container.clientWidth))
      const nextHeight = clamp(Math.floor(window.innerHeight * 0.67), 520, 760)
      setStageSize({ width: nextWidth, height: nextHeight })
    }

    syncLibrary()
    syncStageSize()

    window.addEventListener('storage', syncLibrary)
    window.addEventListener('focus', syncLibrary)
    window.addEventListener('resize', syncStageSize)

    return () => {
      window.removeEventListener('storage', syncLibrary)
      window.removeEventListener('focus', syncLibrary)
      window.removeEventListener('resize', syncStageSize)
    }
  }, [])

  const addPieceFromLibrary = (item: LibraryImage) => {
    const fitScale = 180 / Math.max(item.width, item.height)
    const offset = PIECE_OFFSETS[historyState.doc.pieces.length % PIECE_OFFSETS.length]

    const piece: StudioPiece = {
      id: crypto.randomUUID(),
      imageId: item.id,
      category: item.category,
      title: item.title,
      imageUrl: item.sourceUrl,
      width: item.width,
      height: item.height,
      scale: clamp(fitScale, 0.06, 0.75),
      rotation: 0,
      x: headArea.x + headArea.width / 2 - (item.width * fitScale) / 2 + offset.x,
      y: headArea.y + headArea.height / 2 - (item.height * fitScale) / 2 + offset.y,
    }

    commitDoc((doc) => ({
      ...doc,
      pieces: [...doc.pieces, piece],
    }))
    setSelectedPieceId(piece.id)
  }

  const movePiece = (pieceId: string, x: number, y: number) => {
    commitDoc((doc) => ({
      ...doc,
      pieces: doc.pieces.map((piece) => (piece.id === pieceId ? { ...piece, x, y } : piece)),
    }))
  }

  const transformPiece = (pieceId: string, x: number, y: number, scale: number, rotation: number) => {
    commitDoc((doc) => ({
      ...doc,
      pieces: doc.pieces.map((piece) =>
        piece.id === pieceId
          ? {
              ...piece,
              x,
              y,
              scale: clamp(scale, 0.05, 1.5),
              rotation,
            }
          : piece,
      ),
    }))
  }

  const scaleSelectedPiece = (delta: number) => {
    if (!effectiveSelectedPieceId) {
      return
    }
    commitDoc((doc) => ({
      ...doc,
      pieces: doc.pieces.map((piece) =>
        piece.id === effectiveSelectedPieceId ? { ...piece, scale: clamp(piece.scale + delta, 0.05, 1.5) } : piece,
      ),
    }))
  }

  const movePieceToLayerIndex = (pieceId: string, targetIndex: number) => {
    commitDoc((doc) => {
      const currentIndex = doc.pieces.findIndex((piece) => piece.id === pieceId)
      if (currentIndex < 0) {
        return doc
      }
      const boundedTargetIndex = Math.round(clamp(targetIndex, 0, doc.pieces.length - 1))
      if (currentIndex === boundedTargetIndex) {
        return doc
      }
      const nextPieces = [...doc.pieces]
      const [pieceToMove] = nextPieces.splice(currentIndex, 1)
      if (!pieceToMove) {
        return doc
      }
      nextPieces.splice(boundedTargetIndex, 0, pieceToMove)
      return {
        ...doc,
        pieces: nextPieces,
      }
    })
  }

  const movePieceLayerByStep = (pieceId: string, delta: number) => {
    commitDoc((doc) => {
      const currentIndex = doc.pieces.findIndex((piece) => piece.id === pieceId)
      if (currentIndex < 0) {
        return doc
      }
      const nextIndex = currentIndex + delta
      if (nextIndex < 0 || nextIndex > doc.pieces.length - 1) {
        return doc
      }
      const nextPieces = [...doc.pieces]
      const [pieceToMove] = nextPieces.splice(currentIndex, 1)
      if (!pieceToMove) {
        return doc
      }
      nextPieces.splice(nextIndex, 0, pieceToMove)
      return {
        ...doc,
        pieces: nextPieces,
      }
    })
  }

  const moveSelectedPieceOneLayerUp = () => {
    if (!effectiveSelectedPieceId) {
      return
    }
    movePieceLayerByStep(effectiveSelectedPieceId, 1)
  }

  const moveSelectedPieceOneLayerDown = () => {
    if (!effectiveSelectedPieceId) {
      return
    }
    movePieceLayerByStep(effectiveSelectedPieceId, -1)
  }

  const bringSelectedPieceToFront = () => {
    if (!effectiveSelectedPieceId) {
      return
    }
    movePieceToLayerIndex(effectiveSelectedPieceId, historyState.doc.pieces.length - 1)
  }

  const sendSelectedPieceToBack = () => {
    if (!effectiveSelectedPieceId) {
      return
    }
    movePieceToLayerIndex(effectiveSelectedPieceId, 0)
  }

  const deleteSelectedPiece = () => {
    if (!effectiveSelectedPieceId) {
      return
    }
    commitDoc((doc) => {
      const nextPieces = doc.pieces.filter((piece) => piece.id !== effectiveSelectedPieceId)
      delete pieceNodeRefs.current[effectiveSelectedPieceId]
      return {
        ...doc,
        pieces: nextPieces,
      }
    })
    setSelectedPieceId(null)
  }

  const duplicateSelectedPiece = () => {
    if (!selectedPiece) {
      return
    }

    const duplicate: StudioPiece = {
      ...selectedPiece,
      id: crypto.randomUUID(),
      title: `${selectedPiece.title} (Kopie)`,
      x: selectedPiece.x + 24,
      y: selectedPiece.y + 24,
    }

    commitDoc((doc) => ({
      ...doc,
      pieces: [...doc.pieces, duplicate],
    }))
    setSelectedPieceId(duplicate.id)
  }

  const clearCanvasPieces = () => {
    if (historyState.doc.pieces.length === 0) {
      return
    }
    commitDoc((doc) => ({
      ...doc,
      pieces: [],
    }))
    pieceNodeRefs.current = {}
    setSelectedPieceId(null)
    setStatusMessage('Leinwand geleert.')
  }

  const deletePieceById = (pieceId: string) => {
    commitDoc((doc) => ({
      ...doc,
      pieces: doc.pieces.filter((piece) => piece.id !== pieceId),
    }))
    delete pieceNodeRefs.current[pieceId]
    if (effectiveSelectedPieceId === pieceId) {
      setSelectedPieceId(null)
    }
  }

  const cancelScissorDraw = (message?: string) => {
    setIsDrawingScissor(false)
    setScissorPoints([])
    setCutTargetPieceId(null)
    if (message) {
      setStatusMessage(message)
    }
  }

  const startScissorDraw = (
    stage: KonvaStage,
    pointerEvent?: MouseEvent | TouchEvent | PointerEvent,
  ) => {
    const worldPoint = toWorldPoint(stage, camera)
    if (!worldPoint) {
      return
    }

    const selectedTarget = selectedPiece && isInsidePiece(worldPoint, selectedPiece) ? selectedPiece : null
    const topPiece = selectedTarget ?? findTopPieceAtPoint(historyState.doc.pieces, worldPoint)
    if (!topPiece) {
      return
    }

    const isTouchLikeEvent =
      (pointerEvent && 'pointerType' in pointerEvent && pointerEvent.pointerType === 'touch') ||
      (pointerEvent && 'touches' in pointerEvent && pointerEvent.touches.length > 0)
    scissorCloseDistanceRef.current = isTouchLikeEvent ? SCISSOR_CLOSE_DISTANCE_TOUCH : SCISSOR_CLOSE_DISTANCE_MOUSE

    setStatusMessage('Schere aktiv: auf dem Bild ziehen und loslassen, dann wird ausgeschnitten.')
    setSelectedPieceId(topPiece.id)
    setCutTargetPieceId(topPiece.id)
    setIsDrawingScissor(true)
    setScissorPoints([worldPoint])
  }

  const continueScissorDraw = (stage: KonvaStage) => {
    if (!isDrawingScissor) {
      return
    }
    const worldPoint = toWorldPoint(stage, camera)
    if (!worldPoint) {
      return
    }
    setScissorPoints((previous) => {
      const last = previous[previous.length - 1]
      if (last && distance(last, worldPoint) < 3) {
        return previous
      }
      return [...previous, worldPoint]
    })
  }

  const finishScissorDraw = async (forceClose: boolean) => {
    if (isCutProcessingRef.current) {
      return
    }

    const targetId = cutTargetPieceId
    const capturedPoints = [...scissorPoints]

    if (!targetId || capturedPoints.length < 3) {
      cancelScissorDraw()
      return
    }

    const isClosedEnough = isScissorCloseEnough(capturedPoints, camera.scale, scissorCloseDistanceRef.current)
    if (!isClosedEnough && !forceClose) {
      cancelScissorDraw('Bitte die Linie am Startpunkt schliessen, dann wird ausgeschnitten.')
      return
    }
    cancelScissorDraw()
    setStatusMessage('Schnitt wird berechnet...')

    const pointsForCut = [...capturedPoints]
    if (distance(pointsForCut[0], pointsForCut[pointsForCut.length - 1]) > 0.001) {
      pointsForCut.push(pointsForCut[0])
    }

    const sourcePiece = currentDocRef.current.pieces.find((piece) => piece.id === targetId)
    if (!sourcePiece) {
      return
    }

    const localPoints = pointsForCut.map((point) => ({
      x: clamp((point.x - sourcePiece.x) / sourcePiece.scale, 0, sourcePiece.width),
      y: clamp((point.y - sourcePiece.y) / sourcePiece.scale, 0, sourcePiece.height),
    }))

    const closedPolygon = localPoints
    if (closedPolygon.length < 4) {
      return
    }

    try {
      isCutProcessingRef.current = true
      const image = await loadImageElement(sourcePiece.imageUrl)
      const baseCanvas = renderPieceToCanvas(image, sourcePiece)

      const selectedCanvas = document.createElement('canvas')
      selectedCanvas.width = baseCanvas.width
      selectedCanvas.height = baseCanvas.height
      const selectedContext = selectedCanvas.getContext('2d')
      if (!selectedContext) {
        throw new Error('Kein Canvas-Kontext fuer Auswahl')
      }
      selectedContext.drawImage(baseCanvas, 0, 0)
      selectedContext.globalCompositeOperation = 'destination-in'
      selectedContext.fillStyle = '#000'
      drawPathFromPoints(selectedContext, closedPolygon)
      selectedContext.fill()
      selectedContext.globalCompositeOperation = 'source-over'

      const remainingCanvas = document.createElement('canvas')
      remainingCanvas.width = baseCanvas.width
      remainingCanvas.height = baseCanvas.height
      const remainingContext = remainingCanvas.getContext('2d')
      if (!remainingContext) {
        throw new Error('Kein Canvas-Kontext fuer Rest')
      }
      remainingContext.drawImage(baseCanvas, 0, 0)
      remainingContext.globalCompositeOperation = 'destination-out'
      remainingContext.fillStyle = '#000'
      drawPathFromPoints(remainingContext, closedPolygon)
      remainingContext.fill()
      remainingContext.globalCompositeOperation = 'source-over'

      const selectedCrop = cropCanvasToOpaquePixels(selectedCanvas)
      const remainingCrop = cropCanvasToOpaquePixels(remainingCanvas)

      if (!selectedCrop || !remainingCrop) {
        setStatusMessage('Der Schnitt war zu klein. Bitte einen groesseren Bereich umranden.')
        return
      }

      const selectedPieceNew: StudioPiece = {
        id: crypto.randomUUID(),
        imageId: sourcePiece.imageId,
        category: sourcePiece.category,
        title: `${sourcePiece.title} (Schnipsel)`,
        imageUrl: selectedCrop.canvas.toDataURL('image/png'),
        x: sourcePiece.x + selectedCrop.offsetX * sourcePiece.scale,
        y: sourcePiece.y + selectedCrop.offsetY * sourcePiece.scale,
        width: selectedCrop.canvas.width,
        height: selectedCrop.canvas.height,
        scale: sourcePiece.scale,
        rotation: sourcePiece.rotation ?? 0,
      }

      const remainingPieceNew: StudioPiece = {
        id: crypto.randomUUID(),
        imageId: sourcePiece.imageId,
        category: sourcePiece.category,
        title: `${sourcePiece.title} (Rest)`,
        imageUrl: remainingCrop.canvas.toDataURL('image/png'),
        x: sourcePiece.x + remainingCrop.offsetX * sourcePiece.scale,
        y: sourcePiece.y + remainingCrop.offsetY * sourcePiece.scale,
        width: remainingCrop.canvas.width,
        height: remainingCrop.canvas.height,
        scale: sourcePiece.scale,
        rotation: sourcePiece.rotation ?? 0,
      }

      commitDoc((doc) => {
        const index = doc.pieces.findIndex((piece) => piece.id === targetId)
        if (index < 0) {
          return doc
        }
        const before = doc.pieces.slice(0, index)
        const after = doc.pieces.slice(index + 1)
        return {
          ...doc,
          pieces: [...before, remainingPieceNew, selectedPieceNew, ...after],
        }
      })

      setSelectedPieceId(selectedPieceNew.id)
      setTool('hand')
      setStatusMessage('Schnitt fertig: Schnipsel und Rest sind jetzt zwei getrennte Teile.')
    } catch {
      setStatusMessage('Schnitt fehlgeschlagen. Bitte ein anderes Bild probieren.')
    } finally {
      isCutProcessingRef.current = false
    }
  }

  const onStagePointerDown = (event: KonvaEventObject<MouseEvent | TouchEvent | PointerEvent>) => {
    const stage = stageRef.current
    if (!stage) {
      return
    }

    if (tool === 'scissors') {
      startScissorDraw(stage, event.evt)
      return
    }

    if (tool === 'hand' && (event.target === stage || event.target.name() === 'workspace-bg')) {
      setSelectedPieceId(null)
    }
  }

  const onStagePointerMove = () => {
    const stage = stageRef.current
    if (!stage) {
      return
    }

    if (tool === 'scissors') {
      continueScissorDraw(stage)
      return
    }
  }

  const onStagePointerUp = () => {
    if (tool === 'scissors' && isDrawingScissor) {
      void finishScissorDraw(true)
    }
  }

  undoRef.current = undo
  redoRef.current = redo
  deleteSelectedPieceRef.current = deleteSelectedPiece
  cancelScissorDrawRef.current = cancelScissorDraw
  selectedPieceIdRef.current = effectiveSelectedPieceId
  isDrawingScissorRef.current = isDrawingScissor
  stageSizeRef.current = stageSize

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }

      const hasMeta = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (hasMeta && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          redoRef.current()
        } else {
          undoRef.current()
        }
        return
      }

      if (hasMeta && key === 'y') {
        event.preventDefault()
        redoRef.current()
        return
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPieceIdRef.current) {
        event.preventDefault()
        deleteSelectedPieceRef.current()
        return
      }

      if (event.key === 'Escape' && isDrawingScissorRef.current) {
        event.preventDefault()
        cancelScissorDrawRef.current('Schere abgebrochen.')
        return
      }

      if (key === '+' || key === '=') {
        event.preventDefault()
        setCamera((previous) => {
          const centerPoint = {
            x: stageSizeRef.current.width / 2,
            y: stageSizeRef.current.height / 2,
          }
          const nextScale = clamp(previous.scale + 0.1, 0.5, 2.4)
          const worldX = (centerPoint.x - previous.x) / previous.scale
          const worldY = (centerPoint.y - previous.y) / previous.scale
          return {
            scale: nextScale,
            x: centerPoint.x - worldX * nextScale,
            y: centerPoint.y - worldY * nextScale,
          }
        })
        return
      }

      if (key === '-' || key === '_') {
        event.preventDefault()
        setCamera((previous) => {
          const centerPoint = {
            x: stageSizeRef.current.width / 2,
            y: stageSizeRef.current.height / 2,
          }
          const nextScale = clamp(previous.scale - 0.1, 0.5, 2.4)
          const worldX = (centerPoint.x - previous.x) / previous.scale
          const worldY = (centerPoint.y - previous.y) / previous.scale
          return {
            scale: nextScale,
            x: centerPoint.x - worldX * nextScale,
            y: centerPoint.y - worldY * nextScale,
          }
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const zoomByButton = (delta: number) => {
    const centerPoint = { x: stageSize.width / 2, y: stageSize.height / 2 }
    const nextScale = clamp(camera.scale + delta, 0.5, 2.4)
    const worldX = (centerPoint.x - camera.x) / camera.scale
    const worldY = (centerPoint.y - camera.y) / camera.scale
    setCamera({
      scale: nextScale,
      x: centerPoint.x - worldX * nextScale,
      y: centerPoint.y - worldY * nextScale,
    })
  }

  const exportAsPng = async () => {
    const stage = stageRef.current
    if (!stage || isExportingImage) {
      return
    }

    try {
      setIsExportingImage(true)
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve())
        })
      })

      const rawCanvas = stage.toCanvas({
        x: headArea.x * camera.scale + camera.x,
        y: headArea.y * camera.scale + camera.y,
        width: headArea.width * camera.scale,
        height: headArea.height * camera.scale,
        pixelRatio: 2,
      })

      const dataUrl = rawCanvas.toDataURL('image/png')

      const link = document.createElement('a')
      link.href = dataUrl
      link.download = `gesicht-collage-${Date.now()}.png`
      link.click()
    } catch {
      window.alert('PNG-Export fehlgeschlagen. Bei manchen externen Bildern blockiert der Browser den Download.')
    } finally {
      setIsExportingImage(false)
    }
  }

  const movePieceOneLayerUpById = (pieceId: string) => {
    movePieceLayerByStep(pieceId, 1)
    setSelectedPieceId(pieceId)
  }

  const movePieceOneLayerDownById = (pieceId: string) => {
    movePieceLayerByStep(pieceId, -1)
    setSelectedPieceId(pieceId)
  }

  const canMoveSelectedPieceUp = selectedPieceIndex >= 0 && selectedPieceIndex < historyState.doc.pieces.length - 1
  const canMoveSelectedPieceDown = selectedPieceIndex > 0

  return (
    <main className="page studio-page">
      <section className="info-card">
        <h2>Kinder-Studio</h2>
        <p>
          Hand-Werkzeug zum Bewegen, Schere zum Ausschneiden, Undo für mehrere Schritte und PNG-Export am Ende.
        </p>
      </section>

      <section className="studio-toolbar">
        <button
          type="button"
          className={tool === 'hand' ? 'tool-button icon-only active' : 'tool-button icon-only'}
          onClick={() => {
            if (isDrawingScissor) {
              cancelScissorDraw()
            }
            setTool('hand')
            setStatusMessage('Hand aktiv: Teile bewegen oder ueber Eckpunkte groesser/kleiner ziehen.')
          }}
          title="Hand"
          aria-label="Hand"
        >
          <img src="/images/tool-hand.svg" alt="" aria-hidden="true" />
        </button>
        {tool === 'scissors' ? (
          <>
            <button
              type="button"
              className={scissorCanClose ? 'tool-button icon-only highlight' : 'tool-button icon-only'}
              onClick={() => {
                void finishScissorDraw(true)
              }}
              disabled={!isDrawingScissor || scissorPoints.length < 3}
              title="Schnitt abschliessen"
              aria-label="Schnitt abschliessen"
            >
              <img src="/images/tool-check.svg" alt="" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="tool-button icon-only"
              onClick={() => {
                cancelScissorDraw('Schere abgebrochen.')
              }}
              disabled={!isDrawingScissor}
              title="Schere abbrechen"
              aria-label="Schere abbrechen"
            >
              <img src="/images/tool-close.svg" alt="" aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="tool-button icon-only"
          onClick={undo}
          disabled={historyState.past.length === 0}
          title="Undo"
          aria-label="Undo"
        >
          <img src="/images/tool-undo.svg" alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button icon-only"
          onClick={redo}
          disabled={historyState.future.length === 0}
          title="Redo"
          aria-label="Redo"
        >
          <img src="/images/tool-redo.svg" alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button icon-only"
          onClick={() => zoomByButton(0.1)}
          title="Zoom plus"
          aria-label="Zoom plus"
        >
          <img src="/images/tool-zoom-in.svg" alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button icon-only"
          onClick={() => zoomByButton(-0.1)}
          title="Zoom minus"
          aria-label="Zoom minus"
        >
          <img src="/images/tool-zoom-out.svg" alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button icon-only"
          onClick={exportAsPng}
          title="Als PNG speichern"
          aria-label="Als PNG speichern"
        >
          <img src="/images/tool-save.svg" alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tool-button icon-only"
          onClick={clearCanvasPieces}
          disabled={historyState.doc.pieces.length === 0}
          title="Leinwand leeren"
          aria-label="Leinwand leeren"
        >
          <img src="/images/tool-trash.svg" alt="" aria-hidden="true" />
        </button>
      </section>
      {statusMessage ? <p className="status-text">{statusMessage}</p> : null}
      <p className="zoom-hint">Zoom nur mit den +/− Buttons. Scrollen ueber dem Canvas bewegt die Seite.</p>

      <section className="studio-layout">
        <aside className="panel left-panel ipad-assets-panel">
          <h3>Kategorien & Bauteile</h3>
          <p className="muted-text">Links waehlen, rechts sofort auf dem Gesicht platzieren.</p>
          <div className="category-list">
            {CATEGORIES.map((category) => {
              const items = libraryStore.items.filter((item) => item.category === category.id)
              const isActive = activeCategory === category.id
              return (
                <div key={category.id} className="category-dropdown-block">
                  <button
                    type="button"
                    className={isActive ? 'category-button active' : 'category-button'}
                    onClick={() => setActiveCategory(category.id)}
                  >
                    <span className="category-icon">
                      <img src={category.iconImageUrl} alt={category.label} loading="lazy" />
                    </span>
                    <span>{category.label}</span>
                    <span className="count-pill">{items.length}</span>
                  </button>
                  {isActive ? (
                    <div className="category-dropdown">
                      {items.length === 0 ? (
                        <p className="muted-text">Keine Bilder in dieser Kategorie.</p>
                      ) : (
                        <div className="category-thumb-grid">
                          {items.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className="category-thumb-item"
                              onClick={() => addPieceFromLibrary(item)}
                            >
                              <img src={item.thumbUrl} alt={item.title} loading="lazy" />
                              <span>{item.title}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>

          <h3>Kopf-Umriss</h3>
          <div className="shape-switcher">
            {HEAD_SHAPES.map((shape) => (
              <button
                key={shape.id}
                type="button"
                className={historyState.doc.headShape === shape.id ? 'shape-option active' : 'shape-option'}
                onClick={() => {
                  commitDoc((doc) => ({ ...doc, headShape: shape.id }))
                }}
              >
                <img src={shape.imageUrl} alt={shape.label} />
                <span>{shape.label}</span>
              </button>
            ))}
          </div>

          <h3>Ausgewaehltes Schnipsel</h3>
          <div className="piece-actions">
            <button type="button" onClick={() => scaleSelectedPiece(0.05)} disabled={!selectedPiece}>
              Groesser
            </button>
            <button type="button" onClick={() => scaleSelectedPiece(-0.05)} disabled={!selectedPiece}>
              Kleiner
            </button>
            <button type="button" onClick={moveSelectedPieceOneLayerUp} disabled={!canMoveSelectedPieceUp}>
              1 Ebene hoch
            </button>
            <button type="button" onClick={moveSelectedPieceOneLayerDown} disabled={!canMoveSelectedPieceDown}>
              1 Ebene runter
            </button>
            <button type="button" onClick={bringSelectedPieceToFront} disabled={!canMoveSelectedPieceUp}>
              Nach vorne
            </button>
            <button type="button" onClick={sendSelectedPieceToBack} disabled={!canMoveSelectedPieceDown}>
              Nach hinten
            </button>
            <button type="button" onClick={duplicateSelectedPiece} disabled={!selectedPiece}>
              Duplizieren
            </button>
            <button type="button" onClick={deleteSelectedPiece} disabled={!selectedPiece}>
              Entfernen
            </button>
          </div>
        </aside>

        <div className="canvas-column">
          <div className={tool === 'scissors' ? 'stage-wrap scissors-mode' : 'stage-wrap'} ref={stageContainerRef}>
          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerLeave={onStagePointerUp}
          >
            <Layer x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}>
              <Rect
                name="workspace-bg"
                x={0}
                y={0}
                width={stageSize.width}
                height={stageSize.height}
                fill="#fcf5df"
              />
              <Rect
                x={headArea.x}
                y={headArea.y}
                width={headArea.width}
                height={headArea.height}
                fill="#ffffff"
                opacity={0.75}
                listening={false}
              />
              <HeadGuide shapeId={historyState.doc.headShape} area={headArea} />
              {historyState.doc.pieces.map((piece) => (
                <PieceNode
                  key={piece.id}
                  piece={piece}
                  selected={piece.id === effectiveSelectedPieceId}
                  showSelection={!isExportingImage}
                  tool={tool}
                  assignRef={(pieceId, node) => {
                    pieceNodeRefs.current[pieceId] = node
                  }}
                  onSelect={setSelectedPieceId}
                  onDragEnd={movePiece}
                  onTransformEnd={transformPiece}
                  onDelete={deletePieceById}
                  onMoveLayerUp={movePieceOneLayerUpById}
                  onMoveLayerDown={movePieceOneLayerDownById}
                  canMoveLayerUp={piece.id === effectiveSelectedPieceId && canMoveSelectedPieceUp}
                  canMoveLayerDown={piece.id === effectiveSelectedPieceId && canMoveSelectedPieceDown}
                />
              ))}
              {tool === 'hand' && !isExportingImage ? (
                <Transformer
                  ref={transformerRef}
                  rotateEnabled
                  flipEnabled={false}
                  keepRatio
                  enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                  borderEnabled={false}
                  anchorSize={15}
                  anchorFill="#ffffff"
                  anchorStroke="#0d8f6f"
                  rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
                />
              ) : null}
              {scissorPoints.length > 1 && !isExportingImage ? (
                <>
                  <Line
                    points={flattenPoints(scissorPoints)}
                    stroke="#49280f"
                    opacity={0.45}
                    strokeWidth={10}
                    lineCap="round"
                    lineJoin="round"
                    strokeScaleEnabled={false}
                    listening={false}
                  />
                  <Line
                    points={flattenPoints(scissorPoints)}
                    stroke="#f15a2a"
                    strokeWidth={7}
                    lineCap="round"
                    lineJoin="round"
                    dash={[16, 10]}
                    strokeScaleEnabled={false}
                    listening={false}
                  />
                  {scissorStartPoint && scissorLastPoint ? (
                    <Line
                      points={[scissorLastPoint.x, scissorLastPoint.y, scissorStartPoint.x, scissorStartPoint.y]}
                      stroke={scissorCanClose ? '#1f9d7d' : '#b58c3c'}
                      strokeWidth={2}
                      dash={[5, 7]}
                      strokeScaleEnabled={false}
                      listening={false}
                    />
                  ) : null}
                </>
              ) : null}
              {scissorStartPoint && !isExportingImage ? (
                <Circle
                  x={scissorStartPoint.x}
                  y={scissorStartPoint.y}
                  radius={scissorCanClose ? 11 : 9}
                  fill={scissorCanClose ? '#def9ef' : '#fff6e4'}
                  stroke={scissorCanClose ? '#1f9d7d' : '#d9a147'}
                  strokeWidth={2}
                  listening={false}
                />
              ) : null}
            </Layer>
          </Stage>
          </div>

        </div>
      </section>
    </main>
  )
}
