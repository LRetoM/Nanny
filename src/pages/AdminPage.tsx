import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Stage as KonvaStage } from 'konva/lib/Stage'
import { Circle, Image as KonvaImage, Layer, Line, Rect, Stage } from 'react-konva'
import { QUICK_SEARCH_TERMS, STARTER_SEARCH_TERMS } from '../constants'
import { useLoadedImage } from '../hooks/useLoadedImage'
import { deleteLocalAdminAssets, getManagedLocalAssetPath, saveLocalAdminAsset } from '../lib/localAssets'
import {
  clearLibrary,
  deleteLibraryImage,
  loadLibraryStore,
  mergeLibraryImages,
  updateLibraryImage,
  upsertLibraryImage,
} from '../lib/storage'
import { searchWikimediaCommons } from '../lib/wikimedia'
import { CATEGORIES, type AssetCategory, type LibraryImage, type LibraryStore, type SearchImageResult } from '../types'

interface Point {
  x: number
  y: number
}

interface RectFrame {
  x: number
  y: number
  width: number
  height: number
}

interface CropSession {
  mode: 'add' | 'replace'
  imageId?: string
  originalCreatedAt?: string
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
}

const CROP_STAGE_WIDTH = 920
const CROP_STAGE_HEIGHT = 560
const CROP_STAGE_PADDING = 24
const MAX_STORED_IMAGE_EDGE = 900
const MIN_CROP_POINTS = 3
const DRAW_POINT_DISTANCE = 3
const CROP_CLOSE_DISTANCE = 30

type CropToolMode = 'scissors' | 'hand'

function formatCount(items: LibraryImage[], category: AssetCategory): string {
  return String(items.filter((item) => item.category === category).length)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
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

function closePolygon(points: Point[]): Point[] {
  if (points.length < 3) {
    return points
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (distance(first, last) < 0.001) {
    return points
  }
  return [...points, first]
}

function cropCanvasToOpaquePixels(source: HTMLCanvasElement): HTMLCanvasElement | null {
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

  return croppedCanvas
}

function resizeCanvasForStorage(source: HTMLCanvasElement): HTMLCanvasElement {
  const longestEdge = Math.max(source.width, source.height)
  if (longestEdge <= MAX_STORED_IMAGE_EDGE) {
    return source
  }

  const scaleFactor = MAX_STORED_IMAGE_EDGE / longestEdge
  const resizedCanvas = document.createElement('canvas')
  resizedCanvas.width = Math.max(1, Math.round(source.width * scaleFactor))
  resizedCanvas.height = Math.max(1, Math.round(source.height * scaleFactor))
  const resizedContext = resizedCanvas.getContext('2d')
  if (!resizedContext) {
    return source
  }

  resizedContext.imageSmoothingEnabled = true
  resizedContext.imageSmoothingQuality = 'high'
  resizedContext.clearRect(0, 0, resizedCanvas.width, resizedCanvas.height)
  resizedContext.drawImage(source, 0, 0, resizedCanvas.width, resizedCanvas.height)
  return resizedCanvas
}

function canvasToStorageDataUrl(source: HTMLCanvasElement): string {
  const webpDataUrl = source.toDataURL('image/webp', 0.9)
  if (webpDataUrl.startsWith('data:image/webp')) {
    return webpDataUrl
  }
  return source.toDataURL('image/png')
}

function mapStagePointToImage(point: Point, frame: RectFrame, imageWidth: number, imageHeight: number): Point {
  const localX = clamp((point.x - frame.x) / frame.width, 0, 1)
  const localY = clamp((point.y - frame.y) / frame.height, 0, 1)
  return {
    x: localX * imageWidth,
    y: localY * imageHeight,
  }
}

function isPointInsideRect(point: Point, rect: RectFrame): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function cutImageByPolygon(
  image: HTMLImageElement,
  polygonOnStage: Point[],
  frame: RectFrame,
): { dataUrl: string; width: number; height: number } | null {
  try {
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return null
    }

    const imagePolygon = closePolygon(polygonOnStage).map((point) =>
      mapStagePointToImage(point, frame, sourceWidth, sourceHeight),
    )

    if (imagePolygon.length < 4) {
      return null
    }

    const baseCanvas = document.createElement('canvas')
    baseCanvas.width = sourceWidth
    baseCanvas.height = sourceHeight
    const baseContext = baseCanvas.getContext('2d')
    if (!baseContext) {
      return null
    }
    baseContext.clearRect(0, 0, sourceWidth, sourceHeight)
    baseContext.drawImage(image, 0, 0, sourceWidth, sourceHeight)

    const selectedCanvas = document.createElement('canvas')
    selectedCanvas.width = sourceWidth
    selectedCanvas.height = sourceHeight
    const selectedContext = selectedCanvas.getContext('2d')
    if (!selectedContext) {
      return null
    }
    selectedContext.drawImage(baseCanvas, 0, 0)
    selectedContext.globalCompositeOperation = 'destination-in'
    selectedContext.fillStyle = '#000'
    drawPathFromPoints(selectedContext, imagePolygon)
    selectedContext.fill()
    selectedContext.globalCompositeOperation = 'source-over'

    const croppedCanvas = cropCanvasToOpaquePixels(selectedCanvas)
    if (!croppedCanvas) {
      return null
    }

    const optimizedCanvas = resizeCanvasForStorage(croppedCanvas)
    return {
      dataUrl: canvasToStorageDataUrl(optimizedCanvas),
      width: optimizedCanvas.width,
      height: optimizedCanvas.height,
    }
  } catch {
    return null
  }
}

export function AdminPage() {
  const [store, setStore] = useState<LibraryStore>(() => loadLibraryStore())
  const [selectedCategory, setSelectedCategory] = useState<AssetCategory>('eyes')
  const [query, setQuery] = useState('portrait eye close up')
  const [results, setResults] = useState<SearchImageResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isStarterLoading, setIsStarterLoading] = useState(false)
  const [isUploadLoading, setIsUploadLoading] = useState(false)
  const [starterMessage, setStarterMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cropSession, setCropSession] = useState<CropSession | null>(null)
  const [queuedCropSessions, setQueuedCropSessions] = useState<CropSession[]>([])
  const [cropTitle, setCropTitle] = useState('')
  const [cropPoints, setCropPoints] = useState<Point[]>([])
  const [isDrawingCrop, setIsDrawingCrop] = useState(false)
  const [isSavingCrop, setIsSavingCrop] = useState(false)
  const [cropMessage, setCropMessage] = useState<string | null>(null)
  const [cropCamera, setCropCamera] = useState({ x: 0, y: 0, scale: 1 })
  const [cropTool, setCropTool] = useState<CropToolMode>('scissors')
  const [isPanningCrop, setIsPanningCrop] = useState(false)

  const cropStageRef = useRef<KonvaStage | null>(null)
  const cropPanStartRef = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null)
  const cropImage = useLoadedImage(cropSession?.sourceUrl ?? '')

  const itemsForCategory = useMemo(
    () => store.items.filter((item) => item.category === selectedCategory),
    [selectedCategory, store.items],
  )

  const cropFrame = useMemo<RectFrame>(() => {
    const imageWidth = cropImage?.naturalWidth ?? cropSession?.width ?? 1
    const imageHeight = cropImage?.naturalHeight ?? cropSession?.height ?? 1
    const fitScale = Math.min(
      (CROP_STAGE_WIDTH - CROP_STAGE_PADDING * 2) / imageWidth,
      (CROP_STAGE_HEIGHT - CROP_STAGE_PADDING * 2) / imageHeight,
    )
    const scaledWidth = imageWidth * fitScale
    const scaledHeight = imageHeight * fitScale
    return {
      x: (CROP_STAGE_WIDTH - scaledWidth) / 2,
      y: (CROP_STAGE_HEIGHT - scaledHeight) / 2,
      width: scaledWidth,
      height: scaledHeight,
    }
  }, [cropImage?.naturalHeight, cropImage?.naturalWidth, cropSession?.height, cropSession?.width])

  const cropCanClose = useMemo(() => {
    if (cropPoints.length < MIN_CROP_POINTS) {
      return false
    }
    return distance(cropPoints[0], cropPoints[cropPoints.length - 1]) * cropCamera.scale <= CROP_CLOSE_DISTANCE
  }, [cropCamera.scale, cropPoints])

  useEffect(() => {
    if (!cropSession) {
      return
    }
    setCropTitle(cropSession.title)
    setCropPoints([])
    setCropCamera({ x: 0, y: 0, scale: 1 })
    setCropTool('scissors')
    setCropMessage('Schere aktiv: Bereich umranden, Scrollrad zum Zoomen, Hand zum Verschieben.')
    setIsDrawingCrop(false)
    setIsPanningCrop(false)
    cropPanStartRef.current = null
  }, [cropSession])

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault()
    setErrorMessage(null)
    setIsLoading(true)

    try {
      const response = await searchWikimediaCommons(query)
      setResults(response)
    } catch {
      setErrorMessage('Suche fehlgeschlagen. Bitte erneut versuchen.')
      setResults([])
    } finally {
      setIsLoading(false)
    }
  }

  const openCropForSearchResult = (result: SearchImageResult) => {
    setErrorMessage(null)
    setStarterMessage(null)
    setQueuedCropSessions([])
    setCropSession({
      mode: 'add',
      category: selectedCategory,
      title: result.title,
      sourceUrl: result.sourceUrl,
      thumbUrl: result.thumbUrl,
      sourcePage: result.sourcePage,
      author: result.author,
      licenseName: result.licenseName,
      licenseUrl: result.licenseUrl,
      width: result.width,
      height: result.height,
    })
  }

  const openCropForLibraryItem = (item: LibraryImage) => {
    setErrorMessage(null)
    setStarterMessage(null)
    setQueuedCropSessions([])
    setCropSession({
      mode: 'replace',
      imageId: item.id,
      originalCreatedAt: item.createdAt,
      category: item.category,
      title: item.title,
      sourceUrl: item.sourceUrl,
      thumbUrl: item.thumbUrl,
      sourcePage: item.sourcePage,
      author: item.author,
      licenseName: item.licenseName,
      licenseUrl: item.licenseUrl,
      width: item.width,
      height: item.height,
    })
  }

  const removeFromLibrary = async (imageId: string) => {
    const item = store.items.find((entry) => entry.id === imageId)
    if (!item) {
      return
    }

    const managedPath = getManagedLocalAssetPath(item.sourceUrl)
    if (managedPath) {
      try {
        await deleteLocalAdminAssets([managedPath])
      } catch {
        setErrorMessage('Lokale Bilddatei konnte nicht geloescht werden. Bitte erneut versuchen.')
        return
      }
    }

    setStore(deleteLibraryImage(imageId))
  }

  const clearLibraryWithManagedFiles = async () => {
    const managedPaths = store.items
      .map((item) => getManagedLocalAssetPath(item.sourceUrl))
      .filter((path): path is string => Boolean(path))

    if (managedPaths.length > 0) {
      try {
        await deleteLocalAdminAssets(managedPaths)
      } catch {
        setErrorMessage('Lokale Bilddateien konnten nicht vollstaendig geloescht werden.')
        return
      }
    }

    setStore(clearLibrary())
    setStarterMessage('Bibliothek und lokale Admin-Dateien wurden geloescht.')
  }

  const loadStarterPack = async () => {
    setErrorMessage(null)
    setStarterMessage(null)
    setIsStarterLoading(true)

    try {
      const collected: LibraryImage[] = []

      for (const category of CATEGORIES) {
        const terms = STARTER_SEARCH_TERMS[category.id]
        const bySource = new Map<string, SearchImageResult>()

        const responses = await Promise.all(terms.map((term) => searchWikimediaCommons(term)))
        for (const response of responses) {
          for (const image of response) {
            if (!bySource.has(image.sourceUrl)) {
              bySource.set(image.sourceUrl, image)
            }
          }
        }

        const selectedImages = Array.from(bySource.values()).slice(0, 14)
        for (const image of selectedImages) {
          collected.push({
            id: crypto.randomUUID(),
            category: category.id,
            title: image.title,
            sourceUrl: image.sourceUrl,
            thumbUrl: image.thumbUrl,
            sourcePage: image.sourcePage,
            author: image.author,
            licenseName: image.licenseName,
            licenseUrl: image.licenseUrl,
            width: image.width,
            height: image.height,
            createdAt: new Date().toISOString(),
          })
        }
      }

      const nextStore = mergeLibraryImages(collected)
      setStore(nextStore)
      setStarterMessage(`Starterpaket geladen: ${collected.length} freie Bilder hinzugefuegt.`)
    } catch {
      setErrorMessage('Starterpaket konnte nicht geladen werden. Bitte spaeter erneut versuchen.')
    } finally {
      setIsStarterLoading(false)
    }
  }

  const fileToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result)
        } else {
          reject(new Error('Datei konnte nicht gelesen werden'))
        }
      }
      reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'))
      reader.readAsDataURL(file)
    })
  }

  const readImageSize = (url: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const image = new window.Image()
      image.onload = () => {
        resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024 })
      }
      image.onerror = () => reject(new Error('Bildgroesse konnte nicht gelesen werden'))
      image.src = url
    })
  }

  const handleUploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0) {
      return
    }

    setErrorMessage(null)
    setStarterMessage(null)
    setIsUploadLoading(true)

    try {
      const files = Array.from(fileList)
      const uploadSessions: CropSession[] = []

      for (const file of files) {
        const dataUrl = await fileToDataUrl(file)
        const { width, height } = await readImageSize(dataUrl)
        uploadSessions.push({
          mode: 'add',
          category: selectedCategory,
          title: file.name.replace(/\.[^.]+$/, ''),
          sourceUrl: dataUrl,
          thumbUrl: dataUrl,
          author: 'Lokaler Upload',
          licenseName: 'Eigene Datei',
          width,
          height,
        })
      }

      if (uploadSessions.length === 0) {
        return
      }

      const categoryName = CATEGORIES.find((entry) => entry.id === selectedCategory)?.label ?? selectedCategory

      if (cropSession) {
        setQueuedCropSessions((previous) => [...previous, ...uploadSessions])
        setStarterMessage(`${uploadSessions.length} Upload(s) fuer ${categoryName} zur Schere-Warteschlange hinzugefuegt.`)
      } else {
        const [firstSession, ...restSessions] = uploadSessions
        setCropSession(firstSession)
        setQueuedCropSessions(restSessions)
        setStarterMessage(`${uploadSessions.length} Upload(s) bereit. Bitte mit Schere zuschneiden und speichern.`)
      }
    } catch {
      setErrorMessage('Upload fehlgeschlagen. Bitte nur gueltige Bilddateien verwenden.')
    } finally {
      event.target.value = ''
      setIsUploadLoading(false)
    }
  }

  const proceedToNextCropSession = () => {
    setCropPoints([])
    setIsDrawingCrop(false)
    setCropMessage(null)

    if (queuedCropSessions.length === 0) {
      setCropSession(null)
      return
    }
    const [nextSession, ...restSessions] = queuedCropSessions
    setQueuedCropSessions(restSessions)
    setCropSession(nextSession)
  }

  const handleCropPointerDown = (
    event: KonvaEventObject<MouseEvent | TouchEvent | PointerEvent>,
  ) => {
    if (!cropSession || !cropImage) {
      return
    }
    const stage = cropStageRef.current
    const pointer = stage?.getPointerPosition()
    if (!stage || !pointer) {
      return
    }

    if (cropTool === 'hand') {
      event.evt.preventDefault()
      setIsPanningCrop(true)
      cropPanStartRef.current = {
        x: pointer.x,
        y: pointer.y,
        cameraX: cropCamera.x,
        cameraY: cropCamera.y,
      }
      setCropMessage('Hand aktiv: Bild verschieben, um den gewuenschten Bereich zu fokussieren.')
      return
    }

    const worldPoint = {
      x: (pointer.x - cropCamera.x) / cropCamera.scale,
      y: (pointer.y - cropCamera.y) / cropCamera.scale,
    }
    if (!isPointInsideRect(worldPoint, cropFrame)) {
      return
    }
    event.evt.preventDefault()
    setIsDrawingCrop(true)
    setCropPoints([worldPoint])
    setCropMessage('Zeichnen... Linie am Ende moeglichst wieder zum Startpunkt fuehren.')
  }

  const handleCropPointerMove = () => {
    if (!cropSession || !cropImage) {
      return
    }
    const stage = cropStageRef.current
    const pointer = stage?.getPointerPosition()
    if (!stage || !pointer) {
      return
    }

    if (cropTool === 'hand' && isPanningCrop && cropPanStartRef.current) {
      const panStart = cropPanStartRef.current
      setCropCamera((previous) => ({
        ...previous,
        x: panStart.cameraX + (pointer.x - panStart.x),
        y: panStart.cameraY + (pointer.y - panStart.y),
      }))
      return
    }

    if (!isDrawingCrop) {
      return
    }

    const worldPoint = {
      x: (pointer.x - cropCamera.x) / cropCamera.scale,
      y: (pointer.y - cropCamera.y) / cropCamera.scale,
    }
    const clampedPoint = {
      x: clamp(worldPoint.x, cropFrame.x, cropFrame.x + cropFrame.width),
      y: clamp(worldPoint.y, cropFrame.y, cropFrame.y + cropFrame.height),
    }

    setCropPoints((previous) => {
      const last = previous[previous.length - 1]
      if (last && distance(last, clampedPoint) * cropCamera.scale < DRAW_POINT_DISTANCE) {
        return previous
      }
      return [...previous, clampedPoint]
    })
  }

  const handleCropWheel = (event: KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault()
    const stage = cropStageRef.current
    if (!stage) {
      return
    }
    const pointer = stage.getPointerPosition()
    if (!pointer) {
      return
    }
    const scaleBy = 1.1
    const direction = event.evt.deltaY < 0 ? 1 : -1
    setCropCamera((prev) => {
      const nextScale = clamp(prev.scale * Math.pow(scaleBy, direction), 0.4, 8)
      const worldX = (pointer.x - prev.x) / prev.scale
      const worldY = (pointer.y - prev.y) / prev.scale
      return {
        scale: nextScale,
        x: pointer.x - worldX * nextScale,
        y: pointer.y - worldY * nextScale,
      }
    })
  }

  const handleCropPointerUp = () => {
    if (cropTool === 'hand') {
      setIsPanningCrop(false)
      cropPanStartRef.current = null
      return
    }

    if (!isDrawingCrop) {
      return
    }
    setIsDrawingCrop(false)
    if (cropPoints.length < MIN_CROP_POINTS) {
      setCropMessage('Bitte einen groesseren Bereich umranden.')
      return
    }
    setCropMessage(cropCanClose ? 'Auswahl bereit. Jetzt speichern.' : 'Auswahl offen. Beim Speichern wird sie geschlossen.')
  }

  const saveCropSelection = async () => {
    if (!cropSession || !cropImage || isSavingCrop) {
      return
    }
    if (cropPoints.length < MIN_CROP_POINTS) {
      setCropMessage('Mindestens 3 Punkte zeichnen, damit ausgeschnitten werden kann.')
      return
    }

    const cutResult = cutImageByPolygon(cropImage, cropPoints, cropFrame)
    if (!cutResult || cutResult.width < 2 || cutResult.height < 2) {
      setCropMessage('Ausschnitt zu klein oder leer. Bitte einen groesseren Bereich waehlen.')
      return
    }

    const normalizedTitle = cropTitle.trim() || cropSession.title || 'Neuer Ausschnitt'
    const categoryLabel = CATEGORIES.find((category) => category.id === cropSession.category)?.label ?? cropSession.category

    try {
      setIsSavingCrop(true)
      const imageId = cropSession.mode === 'replace' && cropSession.imageId ? cropSession.imageId : crypto.randomUUID()
      const previousManagedPath =
        cropSession.mode === 'replace' ? getManagedLocalAssetPath(cropSession.sourceUrl) : null
      const localAssetUrl = await saveLocalAdminAsset({
        category: cropSession.category,
        imageDataUrl: cutResult.dataUrl,
        imageId,
        previousPath: previousManagedPath,
      })

      if (cropSession.mode === 'replace' && cropSession.imageId) {
        const updatedImage: LibraryImage = {
          id: imageId,
          category: cropSession.category,
          title: normalizedTitle,
          sourceUrl: localAssetUrl,
          thumbUrl: localAssetUrl,
          sourcePage: cropSession.sourcePage,
          author: cropSession.author,
          licenseName: cropSession.licenseName,
          licenseUrl: cropSession.licenseUrl,
          width: cutResult.width,
          height: cutResult.height,
          createdAt: cropSession.originalCreatedAt ?? new Date().toISOString(),
        }
        setStore(updateLibraryImage(updatedImage))
        setStarterMessage(`Bild in ${categoryLabel} wurde mit Schere aktualisiert.`)
      } else {
        const newImage: LibraryImage = {
          id: imageId,
          category: cropSession.category,
          title: normalizedTitle,
          sourceUrl: localAssetUrl,
          thumbUrl: localAssetUrl,
          sourcePage: cropSession.sourcePage,
          author: cropSession.author,
          licenseName: cropSession.licenseName,
          licenseUrl: cropSession.licenseUrl,
          width: cutResult.width,
          height: cutResult.height,
          createdAt: new Date().toISOString(),
        }
        setStore(upsertLibraryImage(newImage))
        setStarterMessage(`Neuer Ausschnitt in ${categoryLabel} gespeichert.`)
      }
    } catch {
      setCropMessage(
        'Lokales Speichern fehlgeschlagen. Bitte pruefen, ob der Dev-Server laeuft und genug Speicher frei ist.',
      )
      return
    } finally {
      setIsSavingCrop(false)
    }

    proceedToNextCropSession()
  }

  const cancelCropSession = () => {
    proceedToNextCropSession()
  }

  const cropStartPoint = cropPoints.length > 0 ? cropPoints[0] : null
  const cropLastPoint = cropPoints.length > 0 ? cropPoints[cropPoints.length - 1] : null
  const cropOverlayStrokeDark = 10 / cropCamera.scale
  const cropOverlayStrokeMain = 7 / cropCamera.scale
  const cropOverlayGuideStroke = 3 / cropCamera.scale
  const cropOverlayStartRadius = (cropCanClose ? 11 : 9) / cropCamera.scale
  const cropOverlayStartStroke = 2 / cropCamera.scale
  const cropOverlayDashMain = [16 / cropCamera.scale, 10 / cropCamera.scale]
  const cropOverlayDashGuide = [6 / cropCamera.scale, 8 / cropCamera.scale]

  return (
    <main className="page admin-page">
      <section className="info-card">
        <h2>Admin-Bereich: Freie Bilder sammeln</h2>
        <p>
          Quelle ist Wikimedia Commons (kostenlos, kein Abo, keine API-Key-Pflicht). Neue Bilder werden jetzt zuerst
          mit Schere zugeschnitten und dann der Kategorie zugeordnet.
        </p>
        <div className="admin-actions">
          <button type="button" className="primary-button" onClick={loadStarterPack} disabled={isStarterLoading}>
            {isStarterLoading ? 'Starterpaket laedt...' : 'Starterpaket laden (viele freie Bilder)'}
          </button>
          <label className="upload-label">
            {isUploadLoading ? 'Upload laeuft...' : 'Eigene Bilder hochladen'}
            <input type="file" accept="image/*" multiple onChange={handleUploadFiles} disabled={isUploadLoading} />
          </label>
        </div>
        {starterMessage ? <p className="success-text">{starterMessage}</p> : null}
      </section>

      <section className="admin-layout">
        <aside className="panel categories-panel">
          <h3>Kategorien</h3>
          <div className="category-list">
            {CATEGORIES.map((category) => {
              const active = selectedCategory === category.id
              return (
                <button
                  key={category.id}
                  type="button"
                  className={active ? 'category-button active' : 'category-button'}
                  onClick={() => setSelectedCategory(category.id)}
                >
                  <span className="category-icon">
                    <img src={category.iconImageUrl} alt={category.label} loading="lazy" />
                  </span>
                  <span>{category.label}</span>
                  <span className="count-pill">{formatCount(store.items, category.id)}</span>
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className="danger-button"
            onClick={() => {
              void clearLibraryWithManagedFiles()
            }}
          >
            Gesamte Bibliothek leeren
          </button>
        </aside>

        <div className="panel search-panel">
          <h3>Bilder suchen ({CATEGORIES.find((entry) => entry.id === selectedCategory)?.label})</h3>
          <form className="search-row" onSubmit={runSearch}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="z.B. portrait eye, magazine face, hat portrait"
              aria-label="Suchbegriff"
            />
            <button type="submit" className="primary-button" disabled={isLoading}>
              {isLoading ? 'Suche...' : 'Suchen'}
            </button>
          </form>

          <div className="quick-terms">
            {QUICK_SEARCH_TERMS.map((term) => (
              <button key={term} type="button" className="chip" onClick={() => setQuery(term)}>
                {term}
              </button>
            ))}
          </div>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          {!errorMessage && !isLoading && results.length === 0 ? (
            <p className="muted-text">Suche starten, dann kannst du passende Bilder zuschneiden und speichern.</p>
          ) : null}

          <div className="image-grid">
            {results.map((result) => {
              return (
                <article key={`${result.sourceUrl}-${result.title}`} className="image-card">
                  <img src={result.thumbUrl} alt={result.title} loading="lazy" />
                  <div className="image-card-body">
                    <h4>{result.title}</h4>
                    <p>{result.licenseName ?? 'Lizenzangabe auf Quelle ansehen'}</p>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="primary-button small"
                        onClick={() => openCropForSearchResult(result)}
                      >
                        Mit Schere vorbereiten
                      </button>
                      {result.sourcePage ? (
                        <a href={result.sourcePage} target="_blank" rel="noreferrer">
                          Quelle
                        </a>
                      ) : null}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        <aside className="panel library-panel">
          <h3>Gespeicherte Auswahl</h3>
          <p className="muted-text">
            {itemsForCategory.length} Bild(er) in {CATEGORIES.find((entry) => entry.id === selectedCategory)?.label}
          </p>
          <div className="library-list">
            {itemsForCategory.map((item) => (
              <article key={item.id} className="library-item">
                <img src={item.thumbUrl} alt={item.title} loading="lazy" />
                <div>
                  <h4>{item.title}</h4>
                  <div className="library-item-actions">
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => {
                        openCropForLibraryItem(item)
                      }}
                    >
                      Mit Schere bearbeiten
                    </button>
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => {
                        void removeFromLibrary(item.id)
                      }}
                    >
                      Entfernen
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>

      {cropSession ? (
        <section className="crop-overlay" role="dialog" aria-modal="true">
          <div className="crop-dialog">
            <header className="crop-header">
              <h3>
                Schere: {cropSession.mode === 'replace' ? 'Gespeichertes Bild bearbeiten' : 'Neues Bild zuschneiden'}
              </h3>
              <button type="button" className="tool-button" onClick={cancelCropSession}>
                Schliessen
              </button>
            </header>

            <p className="muted-text">
              Bereich umranden (Maus oder Touch), dann speichern. Die gestrichelte Linie zeigt deine Auswahl.
            </p>
            {queuedCropSessions.length > 0 ? (
              <p className="muted-text">{queuedCropSessions.length} weiteres Bild wartet in der Schere-Warteschlange.</p>
            ) : null}
            {!cropImage ? (
              <p className="error-text">
                Bild wird noch geladen oder ist blockiert. Bitte kurz warten oder ein anderes Bild waehlen.
              </p>
            ) : null}

            <label className="crop-title-field">
              Titel
              <input value={cropTitle} onChange={(event) => setCropTitle(event.target.value)} />
            </label>

            <div className="crop-toolbar" role="toolbar" aria-label="Werkzeuge fuer die Schere">
              <button
                type="button"
                className={cropTool === 'scissors' ? 'tool-button active' : 'tool-button'}
                onClick={() => {
                  setCropTool('scissors')
                  setIsPanningCrop(false)
                  cropPanStartRef.current = null
                  setCropMessage('Schere aktiv: Bereich umranden, Scrollrad zum Zoomen.')
                }}
              >
                ✂️ Schere
              </button>
              <button
                type="button"
                className={cropTool === 'hand' ? 'tool-button active' : 'tool-button'}
                onClick={() => {
                  setCropTool('hand')
                  setIsDrawingCrop(false)
                  setCropMessage('Hand aktiv: gezoomtes Bild verschieben, um Details genau zu treffen.')
                }}
              >
                ✋ Hand
              </button>
              <span className="crop-toolbar-hint">
                Scrollrad = Zoom, Hand = Verschieben, Schere = Ausschneiden
              </span>
            </div>

            <div className={cropTool === 'hand' ? 'crop-stage-wrap hand-mode' : 'crop-stage-wrap scissors-mode'}>
              <Stage
                ref={cropStageRef}
                width={CROP_STAGE_WIDTH}
                height={CROP_STAGE_HEIGHT}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={handleCropPointerUp}
                onPointerLeave={handleCropPointerUp}
                onWheel={handleCropWheel}
              >
                <Layer x={cropCamera.x} y={cropCamera.y} scaleX={cropCamera.scale} scaleY={cropCamera.scale}>
                  <Rect x={0} y={0} width={CROP_STAGE_WIDTH} height={CROP_STAGE_HEIGHT} fill="#fbf4e4" />
                  <Rect
                    x={cropFrame.x}
                    y={cropFrame.y}
                    width={cropFrame.width}
                    height={cropFrame.height}
                    fill="#ffffff"
                    stroke="#d3c4a9"
                    strokeWidth={2}
                  />
                  {cropImage ? (
                    <KonvaImage
                      image={cropImage}
                      x={cropFrame.x}
                      y={cropFrame.y}
                      width={cropFrame.width}
                      height={cropFrame.height}
                    />
                  ) : null}
                  {cropPoints.length > 1 ? (
                    <>
                      <Line
                        points={cropPoints.flatMap((point) => [point.x, point.y])}
                        stroke="#49280f"
                        opacity={0.45}
                        strokeWidth={cropOverlayStrokeDark}
                        lineCap="round"
                        lineJoin="round"
                        dashEnabled={false}
                        strokeScaleEnabled={false}
                        listening={false}
                      />
                      <Line
                        points={cropPoints.flatMap((point) => [point.x, point.y])}
                        stroke="#f15a2a"
                        strokeWidth={cropOverlayStrokeMain}
                        lineCap="round"
                        lineJoin="round"
                        dash={cropOverlayDashMain}
                        strokeScaleEnabled={false}
                        listening={false}
                      />
                      {cropStartPoint && cropLastPoint ? (
                        <Line
                          points={[cropLastPoint.x, cropLastPoint.y, cropStartPoint.x, cropStartPoint.y]}
                          stroke={cropCanClose ? '#1f9d7d' : '#b58c3c'}
                          strokeWidth={cropOverlayGuideStroke}
                          dash={cropOverlayDashGuide}
                          strokeScaleEnabled={false}
                          listening={false}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {cropStartPoint ? (
                    <Circle
                      x={cropStartPoint.x}
                      y={cropStartPoint.y}
                      radius={cropOverlayStartRadius}
                      fill={cropCanClose ? '#def9ef' : '#fff6e4'}
                      stroke={cropCanClose ? '#1f9d7d' : '#d9a147'}
                      strokeWidth={cropOverlayStartStroke}
                      strokeScaleEnabled={false}
                      listening={false}
                    />
                  ) : null}
                </Layer>
              </Stage>
            </div>

            <div className="crop-actions">
              <button
                type="button"
                className="tool-button"
                onClick={() => {
                  setCropCamera((prev) => {
                    const nextScale = clamp(prev.scale * 1.3, 0.4, 8)
                    const cx = CROP_STAGE_WIDTH / 2
                    const cy = CROP_STAGE_HEIGHT / 2
                    const worldX = (cx - prev.x) / prev.scale
                    const worldY = (cy - prev.y) / prev.scale
                    return { scale: nextScale, x: cx - worldX * nextScale, y: cy - worldY * nextScale }
                  })
                }}
                title="Heranzoomen"
              >
                + Zoom
              </button>
              <button
                type="button"
                className="tool-button"
                onClick={() => {
                  setCropCamera((prev) => {
                    const nextScale = clamp(prev.scale * 0.77, 0.4, 8)
                    const cx = CROP_STAGE_WIDTH / 2
                    const cy = CROP_STAGE_HEIGHT / 2
                    const worldX = (cx - prev.x) / prev.scale
                    const worldY = (cy - prev.y) / prev.scale
                    return { scale: nextScale, x: cx - worldX * nextScale, y: cy - worldY * nextScale }
                  })
                }}
                title="Herauszoomen"
              >
                − Zoom
              </button>
              <button
                type="button"
                className="tool-button"
                onClick={() => setCropCamera({ x: 0, y: 0, scale: 1 })}
                title="Zoom zuruecksetzen"
              >
                Zoom reset
              </button>
              <button
                type="button"
                className="tool-button"
                onClick={() => {
                  setCropPoints([])
                  setCropMessage('Auswahl geloescht. Zeichne eine neue Linie.')
                  setIsDrawingCrop(false)
                }}
                disabled={cropPoints.length === 0}
              >
                Auswahl loeschen
              </button>
              <button
                type="button"
                className="tool-button highlight"
                onClick={() => {
                  void saveCropSelection()
                }}
                disabled={!cropImage || isSavingCrop}
              >
                Ausschnitt speichern
              </button>
            </div>

            {cropMessage ? <p className="status-text">{cropMessage}</p> : null}
          </div>
        </section>
      ) : null}
    </main>
  )
}
