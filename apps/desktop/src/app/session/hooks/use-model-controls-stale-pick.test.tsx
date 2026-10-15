// Stale model-pick ordering: a superseded selectModel (newer pick, or a chat
// switch while config.set is in flight) must never roll the pill or a tile back.
import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider
} from '@/store/session'
import * as SessionStates from '@/store/session-states'

import { deferred } from '../../../test/deferred'

import { useModelControls } from './use-model-controls'

const tile = vi.hoisted(() => ({ delegate: null as unknown }))
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setGlobalModel: vi.fn()
}))

vi.mock('@/store/session-states', async importOriginal => {
  const actual = await importOriginal<typeof SessionStates>()

  return {
    ...actual,
    sessionTileDelegate: () => tile.delegate
  }
})

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({
    t: {
      desktop: {
        modelSwitchFailed: 'Model switch failed'
      }
    }
  })
}))

vi.mock('@/store/confirm', () => ({
  confirm: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  dismissNotification: vi.fn(),
  notify: vi.fn(),
  notifyError: (...args: Parameters<typeof notifyError>) => notifyError(...args)
}))

type Controls = ReturnType<typeof useModelControls>

function Harness({
  onReady,
  requestGateway
}: {
  onReady: (controls: Controls) => void
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const controls = useModelControls({
    queryClient: new QueryClient(),
    requestGateway
  })

  onReady(controls)

  return null
}

function resetStores() {
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  setCurrentModel('')
  setCurrentModelSource('')
  setCurrentProvider('')
  SessionStates.$sessionStates.set({})
}

describe('useModelControls stale pick ordering', () => {
  beforeEach(() => {
    notifyError.mockReset()
    resetStores()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetStores()
  })

  it('does not roll a failed older pick back over a newer one that applied', async () => {
    $activeSessionId.set('session-1')
    setCurrentModel('fable-5')
    setCurrentProvider('nous')

    const older = deferred<never>()
    const newer = deferred<unknown>()
    const requestGateway = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    const olderPick = controls.selectModel({ model: 'grok-4.5', provider: 'xai' })
    const newerPick = controls.selectModel({ model: 'gpt-6.1-luna', provider: 'openai' })

    newer.resolve({})
    await expect(newerPick).resolves.toBe(true)
    older.reject(new Error('timeout'))
    await expect(olderPick).resolves.toBe(false)

    expect($currentModel.get()).toBe('gpt-6.1-luna')
    expect($currentProvider.get()).toBe('openai')
  })

  it('does not paint the previous session rollback into a session opened mid-switch', async () => {
    $activeSessionId.set('session-1')
    setCurrentModel('fable-5')
    setCurrentProvider('nous')

    const pending = deferred<never>()
    const requestGateway = vi.fn(() => pending.promise)
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    const pick = controls.selectModel({ model: 'grok-4.5', provider: 'xai' })

    // The user opens another chat; its session.info paints that chat's model.
    $activeSessionId.set('session-2')
    setCurrentModel('gpt-6.1-luna')
    setCurrentProvider('openai')

    pending.reject(new Error('timeout'))
    await expect(pick).resolves.toBe(false)

    expect($currentModel.get()).toBe('gpt-6.1-luna')
    expect($currentProvider.get()).toBe('openai')
  })

  it('does not roll a failed older tile pick back over a newer one that applied', async () => {
    $activeSessionId.set('runtime-a')
    SessionStates.$sessionStates.set({ 'runtime-b': { model: 'old-b', provider: 'provider-b' } } as never)
    const updateSession = vi.fn()
    tile.delegate = { updateSession }

    const older = deferred<never>()
    const newer = deferred<unknown>()
    const requestGateway = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

    const olderPick = result.current.selectModel({ model: 'grok-4.5', provider: 'xai', sessionId: 'runtime-b' })
    const newerPick = result.current.selectModel({ model: 'gpt-6.1-luna', provider: 'openai', sessionId: 'runtime-b' })

    try {
      newer.resolve({})
      await expect(newerPick).resolves.toBe(true)
      updateSession.mockClear()
      older.reject(new Error('timeout'))
      await expect(olderPick).resolves.toBe(false)
    } finally {
      tile.delegate = null
    }

    // The older failure must not repaint the tile with its pre-pick model.
    expect(updateSession).not.toHaveBeenCalled()
  })
})
