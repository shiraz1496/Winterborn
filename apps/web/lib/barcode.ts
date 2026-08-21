/**
 * QR scanning, two engines behind one interface.
 *
 * The native `BarcodeDetector` API (Chrome/Android, and desktop Chrome) is
 * used where available: it decodes every code visible in a single video
 * frame in one call, so several boxes laid out in view are all found at
 * once. iOS Safari has never shipped `BarcodeDetector`
 * (https://caniuse.com/mdn-api_barcodedetector as of 2026), so there this
 * falls back to `@zxing/browser`'s JS decoder, which finds one code per
 * decode attempt rather than every code in the frame -- a real capability
 * difference, not a bug. What does NOT differ between the two paths: every
 * code either engine finds is only ever *proposed*. Nothing here calls a
 * mutating endpoint. The caller (ScanScreen) is responsible for queuing a
 * proposal and requiring a deliberate confirm tap before it does anything
 * -- "the scan finds, the human confirms" holds identically on both paths.
 */

export interface ScanHandle {
  stop: () => void
}

export function nativeBarcodeDetectorSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window
}

/// Starts scanning `video` for QR codes and calls `onDetect` with every
/// distinct value found. Returns a handle whose `stop()` releases the
/// camera. Throws if camera access is denied -- caller shows that as an
/// error state, not a silent no-op.
export async function startScanning(video: HTMLVideoElement, onDetect: (values: string[]) => void): Promise<ScanHandle> {
  if (nativeBarcodeDetectorSupported()) {
    return startNative(video, onDetect)
  }
  return startZxing(video, onDetect)
}

async function startNative(video: HTMLVideoElement, onDetect: (values: string[]) => void): Promise<ScanHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  })
  video.srcObject = stream
  await video.play()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BarcodeDetector has no lib.dom.d.ts entry yet.
  const Detector = (window as any).BarcodeDetector
  const detector = new Detector({ formats: ['qr_code'] })

  let stopped = false
  let raf = 0

  const tick = async () => {
    if (stopped) return
    try {
      if (video.readyState >= video.HAVE_CURRENT_DATA) {
        const codes = await detector.detect(video)
        const values: string[] = codes.map((c: { rawValue: string }) => c.rawValue).filter(Boolean)
        if (values.length > 0) onDetect(values)
      }
    } catch {
      // A single failed detect() (e.g. a mid-frame decode error) shouldn't
      // kill the loop -- just try again next frame.
    }
    raf = requestAnimationFrame(() => void tick())
  }
  raf = requestAnimationFrame(() => void tick())

  return {
    stop: () => {
      stopped = true
      cancelAnimationFrame(raf)
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

async function startZxing(video: HTMLVideoElement, onDetect: (values: string[]) => void): Promise<ScanHandle> {
  const { BrowserQRCodeReader } = await import('@zxing/browser')
  const reader = new BrowserQRCodeReader()

  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    video,
    (result) => {
      if (result) onDetect([result.getText()])
    },
  )

  return { stop: () => controls.stop() }
}
