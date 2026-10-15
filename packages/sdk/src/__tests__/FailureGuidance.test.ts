import { describe, expect, it } from 'vitest'
import { createFailureGuidance } from '../FailureGuidance.js'

describe('createFailureGuidance', () => {
  it('provides stable stage, retryability, and safe next-step guidance', () => {
    expect(createFailureGuidance('RESTORE_TX_FAILED')).toEqual({
      stage: 'confirmation',
      code: 'RESTORE_TX_FAILED',
      retryable: false,
      nextStep: 'Inspect the restore transaction on-chain before retrying.',
    })
  })

  it('allows a wallet-connection retry and accepts a precise stage override', () => {
    expect(createFailureGuidance('WALLET_NOT_CONNECTED', 'restore')).toEqual({
      stage: 'restore',
      code: 'WALLET_NOT_CONNECTED',
      retryable: true,
      nextStep: 'Connect the wallet, then review and retry the transaction.',
    })
  })
})
