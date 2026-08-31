'use client'

import { useRouter } from 'next/navigation'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { Scanner } from '../../components/Scanner'
import { useToast } from '../../lib/toast'

/// Standalone scan surface — market manager arrives at a box, opens Scan
/// from the nav, points the camera. The scanner is opened immediately on
/// mount (no extra button) so it works with one tap. Closing the modal
/// returns to the previous page; a successful scan routes to the parent
/// request so the manager can see the fresh progress in context.
function ScanBody() {
  const router = useRouter()
  const toast = useToast()

  return (
    <div>
      <PageHeader
        eyebrow="Receive"
        title="Scan a box"
        description="Point the camera at a QR label to mark the box received. The box's parent request updates automatically; when every box for a request is in, the request closes on its own."
      />
      <Scanner
        open
        onClose={() => router.back()}
        onScanned={(res) => {
          const boxLabel = res.box.qrToken.slice(0, 8).toUpperCase()
          const contentsSummary = res.box.contents.length === 0
            ? ''
            : res.box.contents.length <= 2
              ? ` (${res.box.contents.map((c) => `${c.colourVariantName} ×${c.quantity}`).join(', ')})`
              : ` (${res.box.contents
                  .slice(0, 2)
                  .map((c) => `${c.colourVariantName} ×${c.quantity}`)
                  .join(', ')} + ${res.box.contents.length - 2} more)`

          /// Multi-request boxes update every request they cover. Build
          /// a short "closed X, Y is 2/3" summary so the operator sees
          /// that ONE scan just advanced multiple requests, not just the
          /// primary one they might have been thinking of.
          const multi = res.requests.length > 1
          const closed = res.requests.filter((r) => r.closed).map((r) => `#${r.id.slice(0, 6)}`)
          const advanced = res.requests
            .filter((r) => !r.closed)
            .map((r) => `#${r.id.slice(0, 6)} (${r.boxesReceived}/${r.boxesTotal})`)
          const summary = [
            closed.length > 0 ? `closed ${closed.join(', ')}` : null,
            advanced.length > 0 ? `advanced ${advanced.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · ')

          if (res.box.alreadyReceived) {
            toast.info(`Box ${boxLabel} was already received.`)
          } else if (multi) {
            toast.success(`Box ${boxLabel} received${contentsSummary} — ${summary}`)
          } else if (res.request?.closed) {
            toast.success(`Box ${boxLabel} received${contentsSummary} — request closed.`)
          } else if (res.request) {
            toast.success(
              `Box ${boxLabel} received${contentsSummary} — ${res.request.boxesReceived} of ${res.request.boxesTotal} in.`,
            )
          } else {
            toast.success(`Box ${boxLabel} received${contentsSummary}.`)
          }
          if (res.request) {
            router.push(`/requests/${res.request.id}`)
          } else {
            router.back()
          }
        }}
      />
    </div>
  )
}

export default function ScanPage() {
  return (
    <RequireAuth roles={['OWNER', 'MARKET_MANAGER']}>
      <ScanBody />
    </RequireAuth>
  )
}
