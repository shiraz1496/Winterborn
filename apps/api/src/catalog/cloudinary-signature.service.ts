import { Injectable, InternalServerErrorException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { UploadSignatureResult } from '@winterborn/shared'

/// Signs a Cloudinary upload directly from the browser, so image bytes
/// never pass through our own server. Only `timestamp` and `folder` are
/// signed -- the two are the only params Cloudinary will accept back on
/// the actual upload request, so a signature can't be replayed to upload
/// somewhere else. See spec: docs/superpowers/specs/2026-08-29-product-photo-upload-design.md
@Injectable()
export class CloudinarySignatureService {
  sign(): UploadSignatureResult {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET
    const folder = process.env.CLOUDINARY_UPLOAD_FOLDER ?? 'winterborn/products'

    if (!cloudName || !apiKey || !apiSecret) {
      throw new InternalServerErrorException('Cloudinary is not configured on this server.')
    }

    const timestamp = Math.floor(Date.now() / 1000)
    // Cloudinary's documented signing scheme: sha1 of the sorted
    // "key=value&..." param string (excluding api_key/signature/file),
    // with the api secret appended directly (no separator).
    const signature = createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest('hex')

    return { timestamp, signature, apiKey, cloudName, folder }
  }
}
