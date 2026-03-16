import { useEffect, useState } from 'react'

export function useLoadedImage(url: string): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    let isMounted = true
    const nextImage = new window.Image()
    nextImage.crossOrigin = 'anonymous'
    nextImage.onload = () => {
      if (isMounted) {
        setImage(nextImage)
      }
    }
    nextImage.onerror = () => {
      if (isMounted) {
        setImage(null)
      }
    }
    nextImage.src = url
    return () => {
      isMounted = false
    }
  }, [url])

  return image
}
