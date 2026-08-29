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
          if (res.box.alreadyReceived) {
            toast.info(`Box ${boxLabel} was already received.`)
          } else if (res.request?.closed) {
            toast.success(`Box ${boxLabel} received — request closed.`)
          } else if (res.request) {
            toast.success(
              `Box ${boxLabel} received — ${res.request.boxesReceived} of ${res.request.boxesTotal} in.`,
            )
          } else {
            toast.success(`Box ${boxLabel} received.`)
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
