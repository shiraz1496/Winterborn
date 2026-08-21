'use client'

import { useEffect, useRef, useState } from 'react'
import type { BoxDto, LocationDto, LoadWithBoxesDto } from '@winterborn/shared'
import { RequireAuth } from '../../components/RequireAuth'
import {
  ApiError,
  createLoad,
  dispatchBox,
  dispatchLoad,
  getBoxByToken,
  getLoad,
  listLocations,
  scanBoxOntoLoad,
} from '../../lib/api'
import { nativeBarcodeDetectorSupported, startScanning, type ScanHandle } from '../../lib/barcode'

type Mode = 'load' | 'quick'

interface ScannedEntry {
  token: string
  box: BoxDto | null
  destinationName: string
  status: 'confirmed' | 'rejected' | 'not-found'
  message?: string
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern)
}

function ScanBody() {
  const [mode, setMode] = useState<Mode>('load')
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [vehicleLabel, setVehicleLabel] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [load, setLoad] = useState<LoadWithBoxesDto | null>(null)

  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [pendingBox, setPendingBox] = useState<BoxDto | null>(null)
  const [pendingDestName, setPendingDestName] = useState<string>('')
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [manualToken, setManualToken] = useState('')
  const [history, setHistory] = useState<ScannedEntry[]>([])
  const [busy, setBusy] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const handleRef = useRef<ScanHandle | null>(null)

  useEffect(() => {
    listLocations()
      .then(setLocations)
      .catch(() => undefined)
  }, [])

  const scanningActive = mode === 'quick' || load !== null

  useEffect(() => {
    if (!scanningActive || !videoRef.current) return
    let cancelled = false
    startScanning(videoRef.current, (values) => {
      setQueue((prev) => {
        const additions = values.filter((v) => !seen.has(v) && !prev.includes(v))
        return additions.length > 0 ? [...prev, ...additions] : prev
      })
    })
      .then((handle) => {
        if (cancelled) {
          handle.stop()
          return
        }
        handleRef.current = handle
        setCameraReady(true)
      })
      .catch((err) => setCameraError(err instanceof Error ? err.message : 'Could not start the camera.'))

    return () => {
      cancelled = true
      handleRef.current?.stop()
      handleRef.current = null
      setCameraReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanningActive])

  // Pop the next queued token once the confirm sheet is free.
  useEffect(() => {
    if (pendingToken !== null || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void resolveToken(next!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingToken, queue])

  async function resolveToken(token: string) {
    setPendingToken(token)
    setPendingError(null)
    try {
      const box = await getBoxByToken(token)
      const destName = locations.find((l) => l.id === box.destinationLocationId)?.name ?? box.destinationLocationId
      setPendingBox(box)
      setPendingDestName(destName)
    } catch {
      setPendingBox(null)
      setPendingDestName('')
      setPendingError('No box matches this code. It may be stale or misprinted.')
    }
  }

  function dismissPending(status: ScannedEntry['status'], message?: string) {
    if (pendingToken) {
      setSeen((prev) => new Set(prev).add(pendingToken))
      setHistory((prev) => [
        { token: pendingToken, box: pendingBox, destinationName: pendingDestName, status, message },
        ...prev,
      ])
    }
    setPendingToken(null)
    setPendingBox(null)
    setPendingDestName('')
    setPendingError(null)
  }

  async function confirmPending() {
    if (!pendingBox) return
    setBusy(true)
    try {
      if (mode === 'quick') {
        await dispatchBox(pendingBox.id)
      } else if (load) {
        await scanBoxOntoLoad(load.id, pendingBox.id)
        setLoad(await getLoad(load.id))
      }
      vibrate(60)
      dismissPending('confirmed')
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not confirm that box.'
      setPendingError(message)
      vibrate([40, 60, 40])
    } finally {
      setBusy(false)
    }
  }

  async function startLoad() {
    if (!vehicleLabel.trim() || !destinationId) return
    setBusy(true)
    try {
      const created = await createLoad({ vehicleLabel: vehicleLabel.trim(), destinationLocationId: destinationId })
      setLoad(await getLoad(created.id))
    } catch (err) {
      setCameraError(err instanceof ApiError ? err.message : 'Could not start the load.')
    } finally {
      setBusy(false)
    }
  }

  async function finishLoad() {
    if (!load) return
    setBusy(true)
    try {
      await dispatchLoad(load.id)
      setLoad(await getLoad(load.id))
    } catch (err) {
      setCameraError(err instanceof ApiError ? err.message : 'Could not dispatch the load.')
    } finally {
      setBusy(false)
    }
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault()
    const token = manualToken.trim()
    if (!token) return
    setManualToken('')
    setQueue((prev) => (seen.has(token) || prev.includes(token) ? prev : [...prev, token]))
  }

  const markets = locations.filter((l) => l.kind === 'MARKET')

  return (
    <div>
      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="chip"
          style={{
            cursor: 'pointer',
            background: mode === 'load' ? 'var(--signal)' : 'transparent',
            color: mode === 'load' ? 'var(--signal-ink)' : 'var(--text-dim)',
            borderColor: mode === 'load' ? 'var(--signal)' : 'var(--line-strong)',
          }}
          onClick={() => {
            setMode('load')
            setLoad(null)
          }}
        >
          Load a van
        </button>
        <button
          className="chip"
          style={{
            cursor: 'pointer',
            background: mode === 'quick' ? 'var(--signal)' : 'transparent',
            color: mode === 'quick' ? 'var(--signal-ink)' : 'var(--text-dim)',
            borderColor: mode === 'quick' ? 'var(--signal)' : 'var(--line-strong)',
          }}
          onClick={() => setMode('quick')}
        >
          Quick dispatch
        </button>
      </div>

      {cameraError && <p className="error-banner">{cameraError}</p>}

      {mode === 'load' && !load && (
        <div className="card stack">
          <p className="eyebrow" style={{ margin: 0 }}>
            Set up the load
          </p>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="vehicle">Vehicle</label>
            <input
              id="vehicle"
              placeholder="e.g. Sprinter 2"
              value={vehicleLabel}
              onChange={(e) => setVehicleLabel(e.target.value)}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="destination">Destination</label>
            <select id="destination" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
              <option value="">Choose a market…</option>
              {markets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={startLoad} disabled={busy || !vehicleLabel.trim() || !destinationId}>
            Start scanning
          </button>
        </div>
      )}

      {(mode === 'quick' || load) && (
        <>
          {mode === 'load' && load && (
            <div className="card row-between" style={{ marginBottom: 16 }}>
              <div>
                <div className="list-row-title">{load.vehicleLabel}</div>
                <div className="list-row-meta">
                  {markets.find((m) => m.id === load.destinationLocationId)?.name} · {load.boxes.length} box
                  {load.boxes.length === 1 ? '' : 'es'} on
                </div>
              </div>
              {load.dispatchedAt ? (
                <span className="chip chip-pine">dispatched</span>
              ) : (
                <button className="btn btn-primary" onClick={finishLoad} disabled={busy || load.boxes.length === 0}>
                  Dispatch load
                </button>
              )}
            </div>
          )}

          <div className="scan-viewport" style={{ marginBottom: 14 }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} muted playsInline autoPlay />
            <div className="scan-frame">
              <span />
            </div>
          </div>

          {!cameraReady && !cameraError && (
            <p className="eyebrow" style={{ marginBottom: 14 }}>
              {nativeBarcodeDetectorSupported() ? 'Starting camera…' : 'Starting camera (fallback scanner)…'}
            </p>
          )}

          <form onSubmit={submitManual} className="row" style={{ marginBottom: 24 }}>
            <input
              placeholder="Or type the box code"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              style={{
                flex: 1,
                minHeight: 'var(--tap-min)',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--line-strong)',
                background: 'var(--surface-sunken)',
                color: 'var(--text)',
              }}
            />
            <button type="submit" className="btn">
              Look up
            </button>
          </form>

          <div className="section-heading">
            <h2>Scanned this session</h2>
            <span className="eyebrow">{history.length}</span>
          </div>
          {history.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>Hold a box label up to the camera.</p>
            </div>
          ) : (
            <div className="list">
              {history.map((h, i) => (
                <div key={`${h.token}-${i}`} className="list-row">
                  <div className="list-row-body">
                    <div className="list-row-title mono">{h.box ? h.box.id.slice(0, 8) : h.token.slice(0, 10)}</div>
                    <div className="list-row-meta">{h.message ?? h.destinationName}</div>
                  </div>
                  <span
                    className={`chip ${h.status === 'confirmed' ? 'chip-pine' : 'chip-rust'}`}
                  >
                    {h.status === 'confirmed' ? 'ok' : h.status === 'rejected' ? 'refused' : 'not found'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {pendingToken && (
        <div className="scan-sheet">
          {pendingBox ? (
            <div className="stack">
              <div className="row-between">
                <span className="eyebrow">Confirm this box</span>
                <span className="mono" style={{ color: 'var(--text-dim)' }}>
                  {pendingBox.id.slice(0, 8)}
                </span>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.3rem' }}>
                  {pendingDestName}
                </div>
                <div className="eyebrow">
                  {pendingBox.lines.length} line{pendingBox.lines.length === 1 ? '' : 's'} · {pendingBox.state.toLowerCase()}
                </div>
              </div>
              {pendingError && <p className="error-banner" style={{ marginBottom: 0 }}>{pendingError}</p>}
              <div className="row">
                <button className="btn" style={{ flex: 1 }} onClick={() => dismissPending('rejected', pendingError ?? undefined)}>
                  Skip
                </button>
                <button className="btn btn-primary" style={{ flex: 2 }} onClick={confirmPending} disabled={busy}>
                  {busy ? 'Confirming…' : mode === 'quick' ? 'Confirm dispatch' : 'Confirm onto load'}
                </button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <p className="error-banner" style={{ marginBottom: 0 }}>{pendingError}</p>
              <button className="btn btn-block" onClick={() => dismissPending('not-found')}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ScanPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE', 'OPERATOR']}>
      <ScanBody />
    </RequireAuth>
  )
}
