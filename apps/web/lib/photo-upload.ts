import imageCompression from 'browser-image-compression'
import type { UploadSignatureResult } from '@winterborn/shared'
import { API_ORIGIN } from './api'

/// Product photo capture/upload for the intake modal (mobile/tablet only).
/// See docs/superpowers/specs/2026-08-29-product-photo-upload-design.md.
///
/// Photos are held as compressed Files in the form until final submit
/// (batch upload, not upload-on-capture -- deliberate: avoids orphaned
/// Cloudinary assets if the user cancels, at the cost of a slower submit).

const MAX_RAW_BYTES = 10 * 1024 * 1024
const TARGET_MB = 3
export const MAX_PHOTOS_PER_SKU = 8

export class PhotoTooLargeError extends Error {}

/** Rejects outright above 10MB; otherwise compresses toward ~3MB, fixing EXIF rotation along the way. */
export async function prepareProductPhoto(file: File): Promise<File> {
  if (file.size > MAX_RAW_BYTES) {
    throw new PhotoTooLargeError(`${file.name} is larger than 10MB — pick a smaller photo.`)
  }
  return imageCompression(file, {
    maxSizeMB: TARGET_MB,
    maxWidthOrHeight: 2000,
    useWebWorker: true,
  })
}

async function getUploadSignature(): Promise<UploadSignatureResult> {
  const res = await fetch(`${API_ORIGIN}/catalog/products/upload-signature`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Could not prepare photo upload. Try again.')
  return res.json() as Promise<UploadSignatureResult>
}

async function uploadOne(file: File, sig: UploadSignatureResult): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('api_key', sig.apiKey)
  form.append('timestamp', String(sig.timestamp))
  form.append('signature', sig.signature)
  form.append('folder', sig.folder)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed for ${file.name}.`)
  const json = (await res.json()) as { secure_url: string }
  return json.secure_url
}

/**
 * Uploads every photo in every cell to Cloudinary, behind one shared
 * signature. All-or-nothing per the design: throws on the first failure
 * without attempting the rest of the batch, and the caller is expected to
 * skip creating the product when this rejects.
 */
export async function uploadProductPhotos(photosByCell: Record<string, File[]>): Promise<Record<string, string[]>> {
  const cells = Object.entries(photosByCell).filter(([, files]) => files.length > 0)
  if (cells.length === 0) return {}
  const sig = await getUploadSignature()
  const result: Record<string, string[]> = {}
  for (const [key, files] of cells) {
    const urls: string[] = []
    for (const file of files) {
      urls.push(await uploadOne(file, sig))
    }
    result[key] = urls
  }
  return result
}
