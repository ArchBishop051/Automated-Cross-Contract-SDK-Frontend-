import type { Memo, Transaction, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import type { ISorobanRpcClient } from './RpcClient.js';
import type {
  TxHash,
  XdrBase64,
  ContractIdHex,
  HexString,
  StellarPublicKey,
  NetworkPassphrase,
  RpcUrl,
  FeeStroops,
  SequenceNumber,
  HistoryEntryId,
} from './branded-types.js';

export type {
  TxHash,
  XdrBase64,
  ContractIdHex,
  HexString,
  StellarPublicKey,
  NetworkPassphrase,
  RpcUrl,
  FeeStroops,
  SequenceNumber,
  HistoryEntryId,
};
export type { OnchainError } from './TransactionFailure.js';
export type { ResurrectErrorCode } from './errors.js';

/**
 * Minimal logger interface used across the SDK.
 *
 * Consumers can inject their own implementation via `config.logger`.
 * When no logger is provided the SDK falls back to {@link NOOP_LOGGER}.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * A logger that discards every message. Used as the default when no
 * logger is injected so the SDK never writes to the console on its own.
 */
export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Resolve the logger to use for a given configuration, falling back to
 * {@link NOOP_LOGGER} when none was provided.
 */
export function resolveLogger(config?: { logger?: Logger }): Logger {
  return config?.logger ?? NOOP_LOGGER;
}

/**
 * Options accepted by {@link TypedEventEmitter}.
 */
export interface EventEmitterOptions {
  /** Optional logger used to report listener failures and leak warnings. */
  logger?: Logger;
  /**
   * Maximum number of listeners allowed for a single event before a leak
   * warning is emitted. Defaults to {@link DEFAULT_MAX_LISTENERS}.
   */
  maxListeners?: number;
}

/** Default listener threshold before a leak warning is emitted. */
export const DEFAULT_MAX_LISTENERS = 10;

/**
 * A typed event map: event name to the listener signature for that event.
 */
export type EventMap = Record<string, (...args: any[]) => void>;

/**
 * A strongly typed event emitter with injectable logging and listener
 * cleanup helpers.
 */
export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<(...args: any[]) => void>>();
  private readonly warnedEvents = new Set<keyof Events>();
  private readonly logger: Logger;
  private readonly maxListeners: number;

  constructor(options: EventEmitterOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
  }

  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);

    if (set.size > this.maxListeners && !this.warnedEvents.has(event)) {
      this.warnedEvents.add(event);
      this.logger.warn(
        `Possible event listener leak detected: "${String(event)}" has ${set.size} listeners ` +
          `(max ${this.maxListeners}).`,
      );
    }

    return this;
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
    return this;
  }

  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper as Events[E]);
      (listener as (...args: any[]) => void)(...args);
    };
    return this.on(event, wrapper as Events[E]);
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }

    for (const listener of Array.from(set)) {
      try {
        (listener as (...args: any[]) => void)(...args);
      } catch (error) {
        this.logger.error(
          `Error in listener for event "${String(event)}":`,
          error,
        );
      }
    }

    return true;
  }

  /**
   * Remove listeners. When `event` is provided only that event's listeners
   * are removed; otherwise every listener for every event is cleared.
   */
  removeAllListeners<E extends keyof Events>(event?: E): this {
    if (event === undefined) {
      this.listeners.clear();
      this.warnedEvents.clear();
    } else {
      this.listeners.delete(event);
      this.warnedEvents.delete(event);
    }
    return this;
  }

  /** Number of listeners currently registered for the given event. */
  listenerCount<E extends keyof Events>(event: E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/**
 * Status of a single ledger entry as reported by {@link queryLedgerTTL}.
 *
 * - `live`: the RPC confirmed the entry exists and is not archived.
 * - `archived`: the RPC confirmed the entry is absent/archived.
 * - `unknown`: the request for this entry failed, so its status could not
 *   be determined. Unknown entries must never be treated as archived.
 */
export type TTLQueryStatus = 'live' | 'archived' | 'unknown';

/**
 * A single entry returned by {@link queryLedgerTTL}.
 */
export interface TTLQueryEntry {
  /** The ledger key this entry describes. */
  key: string;
  /** Whether the entry is live, archived, or of unknown status. */
  status: TTLQueryStatus;
  /**
   * Convenience flag mirroring `status === 'archived'`. Entries whose status
   * is `unknown` are never reported as archived.
   */
  isArchived: boolean;
  /** Remaining TTL in ledgers, when known. */
  ttl?: number;
}

/**
 * Describes a chunk of keys whose `getLedgerEntries` request failed.
 */
export interface TTLQueryChunkError {
  /** Index of the failing chunk within the original request. */
  chunkIndex: number;
  /** The keys that were part of the failing chunk. */
  keys: string[];
  /** The error thrown by the underlying RPC call. */
  error: unknown;
}

/**
 * Result of {@link queryLedgerTTL}.
 *
 * `failedChunks` exposes which chunks failed and why so callers can
 * distinguish a confirmed-absent entry from one whose status is unknown.
 */
export interface TTLQueryResult {
  /** Per-key status, keyed by the requested ledger key. */
  entries: Record<string, TTLQueryEntry>;
  /** Chunks whose request failed, with the underlying error. */
  failedChunks: TTLQueryChunkError[];
  /** Convenience flag: true when at least one chunk failed. */
  hasErrors: boolean;
}

/** Configuration options for creating a SorobanResurrect instance. */
export interface SorobanResurrectConfig {
  /** URL of the Soroban RPC endpoint. */
  rpcUrl: RpcUrl | string;
  /** Network passphrase (defaults to Testnet). */
  networkPassphrase?: NetworkPassphrase | string;
  /** Polling interval in ms when waiting for transaction confirmation. */
  pollIntervalMs?: number;
  /** Timeout in ms when waiting for transaction confirmation. */
  pollTimeoutMs?: number;
  /** Multiplier applied to minResourceFee when building a restore transaction. */
  restoreFeeMultiplier?: number;
  /** Hard cap (in stroops) on the fee a restore transaction may use. */
  maxRestoreFeeStroops?: FeeStroops | string;
  /** Method for detecting archived keys. */
  archiveDetectionMethod?: 'simulation' | 'direct';
  /** Ledger keys per getLedgerEntries request during direct archive detection. */
  archiveDetectionChunkSize?: number;
  /** Concurrent getLedgerEntries requests during direct archive detection. */
  archiveDetectionConcurrency?: number;
  /** Enable simulation caching. */
  enableSimulationCache?: boolean;
  /** Use SSE-based transaction status waiting when available. */
  useSSE?: boolean;
  /** Per-call timeout in ms for RPC calls. */
  rpcTimeoutMs?: number;
  /** Number of retries for transient RPC failures. */
  rpcRetryCount?: number;
  /** Base backoff in ms between RPC retries. */
  rpcRetryBackoffMs?: number;
  /** Consecutive RPC failures before the circuit breaker trips. */
  rpcCircuitBreakerThreshold?: number;
  /** Circuit-breaker cooldown in ms. */
  rpcCircuitBreakerCooldownMs?: number;
  /** Default interval for TTL watches. */
  ttlWatchIntervalMs?: number;
  /** Default low-TTL threshold for TTL watches. */
  ttlWatchThreshold?: number;
  /** Whether TTL watches automatically submit a restore. */
  ttlWatchAutoExtend?: boolean;
  /** Optional memo attached to restore transactions. */
  restoreTxMemo?: Memo;
  /** Plain-string convenience form of restoreTxMemo. */
  restoreTxMemoText?: string;
  /** Maximum number of tx_bad_seq rebuild-and-resubmit attempts. */
  maxSequenceRetries?: number;
  /** Optional RPC client override. */
  rpcClient?: ISorobanRpcClient;
  /** Optional structured logger. */
  logger?: Logger;
  /** Optional history persistence. */
  persistHistory?: HistoryPersistenceOptions;
  /** Simulation cache time-to-live in ms. */
  simulationCacheTtlMs?: number;
  /** Maximum number of cached simulation responses. */
  simulationCacheMaxSize?: number;
  /** Maximum serialized size in bytes allowed for a restore transaction. */
  maxRestoreTxSizeBytes?: number;
  /** Warn once the restore transaction approaches the serialized-size limit. */
  restoreSizeWarnRatio?: number;
  /** Throw rather than warn when a restore transaction exceeds its size limit. */
  throwOnRestoreSizeLimit?: boolean;
}

/** Feature-detection flags a wallet adapter may advertise. */
export interface WalletCapabilities {
  signAuthEntry?: boolean;
  feeBump?: boolean;
  hardware?: boolean;
  maxOperations?: number;
}

/** Wallet interface used to sign Soroban transaction XDR. */
export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<StellarPublicKey>;
  signTransaction(
    tx: XdrBase64,
    opts?: { networkPassphrase?: NetworkPassphrase | string; network?: string },
  ): Promise<XdrBase64>;
  capabilities?: WalletCapabilities;
  getNetwork?(): Promise<string>;
}

export type WalletErrorCode = 'USER_REJECTED' | 'NOT_CONNECTED' | 'NETWORK_MISMATCH' | 'UNKNOWN';

/** Normalized error raised by wallet adapters. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly originalError: unknown;

  constructor(code: WalletErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.originalError = originalError;
  }
}

/** Sponsor interface for fee-bump transactions. */
export interface FeeBumpSponsor {
  getPublicKey(): Promise<StellarPublicKey>;
  signFeeBump(
    txXdr: XdrBase64,
    opts?: { networkPassphrase?: NetworkPassphrase | string },
  ): Promise<XdrBase64>;
}

/** Configuration for fee-bump transactions. */
export interface FeeBumpConfig {
  sponsor: FeeBumpSponsor;
  feeBumpFee?: FeeStroops | string;
}

/** Tuning options for chunked, parallel archive detection. */
export interface ArchiveDetectionOptions {
  chunkSize?: number;
  concurrency?: number;
}

/** One ledger entry detected as archived. */
export interface ArchivedLedgerEntry {
  key: xdr.LedgerKey;
  keyBase64: XdrBase64;
}

/** Soroban RPC simulation response. */
export type SimulateResponse = rpc.Api.SimulateTransactionResponse;

/** Parsed diagnostics for a failed transaction. */
export interface TxDiagnostics {
  events: string[];
  failedOpIndex?: number;
  revertReason?: string;
  resultCodes?: string[];
  rawEventsXdr?: string[];
}

/** Confirmation policy for the original transaction. */
export type ConfirmationPolicy = 'wait-for-finality' | 'return-on-submission';

/** Behavior when confirmation polling reaches its timeout. */
export type ConfirmationTimeoutBehavior = 'error' | 'return-pending';

/** Retry policy for transient RPC transport/server failures. */
export interface SubmitRetryOptions {
  /** Retries beyond the initial RPC call. Defaults to 3 when enabled. */
  maxRetries?: number;
  /** Initial backoff in ms. Defaults to 250. */
  baseDelayMs?: number;
  /** Maximum backoff in ms. Defaults to 5000. */
  maxDelayMs?: number;
}

/** Public result returned from the restore-and-submit workflow. */
export interface ResurrectResult {
  success: boolean;
  originalTxHash?: TxHash;
  restoreTxHash?: TxHash;
  archivedKeysDetected: number;
  error?: string;
  errorCode?: import('./errors.js').ResurrectErrorCode;
  dryRun?: boolean;
  dryRunResult?: DryRunResult;
  historyId?: string;
  sequenceRetries?: number;
  diagnostics?: TxDiagnostics;
  onchainError?: import('./TransactionFailure.js').OnchainError;
  /** `submitted` does not imply on-chain success or finality. */
  confirmationStatus?: 'confirmed' | 'submitted' | 'pending';
}

/** Options for restoring arbitrary ledger keys. */
export interface RestoreKeysOptions {
  onSigningRestore?: () => void;
  onSubmittingRestore?: () => void;
  onRestoreSubmitted?: (txHash: TxHash) => void;
  onRestoreConfirmed?: (txHash: TxHash) => void;
}

/** Detailed result of a dry-run simulation. */
export interface DryRunResult {
  wouldNeedRestore: boolean;
  archivedKeysDetected: number;
  archivedKeys: ArchivedLedgerEntry[];
  estimatedRestoreFee?: FeeStroops;
  simulationError?: string;
}

/** Lifecycle phases reported during a submit-with-restore request. */
export type SubmitLifecyclePhase =
  | 'simulation_started'
  | 'restore_preparation_started'
  | 'restore_submission_started'
  | 'restore_submitted'
  | 'restore_confirmation_started'
  | 'restore_confirmed'
  | 'original_submission_started'
  | 'original_submitted'
  | 'completed'
  | 'failed';

/** Typed event emitted for a submit-with-restore lifecycle phase. */
export interface SubmitLifecycleEvent {
  phase: SubmitLifecyclePhase;
  requestId?: string;
  transactionHash?: TxHash;
  archivedKeys?: ArchivedLedgerEntry[];
  result?: ResurrectResult;
  error?: string;
}

/** Options for submitting a transaction with automatic archive restoration. */
export interface SubmitWithRestoreOptions {
  transaction: Transaction;
  wallet: WalletAdapter;
  feeBumpConfig?: FeeBumpConfig;
  onSigningRestore?: () => void;
  onSubmittingRestore?: () => void;
  onSigningOriginal?: () => void;
  onRestoreNeeded?: (archivedKeys: ArchivedLedgerEntry[]) => void;
  onRestoreSubmitted?: (txHash: TxHash) => void;
  onRestoreConfirmed?: (txHash: TxHash) => void;
  onOriginalSubmitted?: (txHash: TxHash) => void;
  onRestoreFailed?: (error: string) => void;
  /**
   * Called for each typed workflow phase, including simulation, restore
   * preparation/submission/confirmation, original submission, and completion.
   * The same payloads are published through `sdk.on('workflowLifecycle', ...)`.
   */
  onLifecycleEvent?: (event: SubmitLifecycleEvent) => void;
  /** Stable logical identifier used to share an in-flight request. */
  requestId?: string;
  /** Opt-in retries for transient RPC failures only. */
  retry?: SubmitRetryOptions;
  /** Defaults to waiting for a terminal SUCCESS/FAILED RPC status. */
  confirmationPolicy?: ConfirmationPolicy;
  /** Per-call override for the confirmation polling timeout. */
  confirmationTimeoutMs?: number;
  /** Defaults to returning an error when the confirmation timeout expires. */
  confirmationTimeoutBehavior?: ConfirmationTimeoutBehavior;
  restoreTxMemo?: Memo;
  restoreTxMemoText?: string;
}

/** State labels for the restore-and-submit workflow. */
export type RestoreState =
  | 'idle'
  | 'simulating'
  | 'restore_needed'
  | 'signing_restore'
  | 'submitting_restore'
  | 'confirming_restore'
  | 'signing_original'
  | 'submitting_original'
  | 'success'
  | 'error'
  | 'estimating'
  | 'watching_ttl'
  | 'extending_ttl';

/** Snapshot of the current workflow state. */
export interface RestoreStateInfo {
  state: RestoreState;
  message: string;
  archivedKeys?: ArchivedLedgerEntry[];
  error?: string;
}

/** Typed events emitted by SorobanResurrect. */
export interface SorobanResurrectEvents {
  stateChange: RestoreStateInfo;
  restoreNeeded: ArchivedLedgerEntry[];
  restoreSubmitted: TxHash;
  restoreConfirmed: TxHash;
  originalSubmitted: TxHash;
  restoreComplete: ResurrectResult;
  workflowLifecycle: SubmitLifecycleEvent;
  error: string;
  networkChanged: { rpcUrl: string; networkPassphrase: string };
}

/** Logger verbosity level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured context accepted by the SDK logger. */
export interface LogContext extends Record<string, unknown> {
  method?: string;
  durationMs?: number;
  requestId?: string;
  ok?: boolean;
  error?: string;
}

/** Timing information for an RPC call. */
export interface RpcTimingEvent {
  method: string;
  durationMs: number;
  ok: boolean;
  requestId?: string;
  error?: string;
}

/** Storage interface used by history persistence. */
export interface HistoryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

/** Options for persisting transaction history. */
export interface HistoryPersistenceOptions {
  storage: HistoryStorage;
  key?: string;
  mode?: 'full' | 'minimal';
  serializer?: {
    serialize(value: string): string | Promise<string>;
    deserialize(value: string): string | Promise<string>;
  };
}

/** Hardware wallet adapter lifecycle. */
export interface HardwareWalletAdapter extends WalletAdapter {
  readonly type: 'ledger' | 'trezor';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAppVersion(): Promise<string>;
}

/** Configuration for the Ledger adapter. */
export interface LedgerAdapterConfig {
  transport?: unknown;
  accountIndex?: number;
}

/** Configuration for the Trezor adapter. */
export interface TrezorAdapterConfig {
  trezorConnect: unknown;
  manifest: { email: string; appUrl: string };
  accountIndex?: number;
}

/**
 * A single entry in the SDK transaction history.
 */
export interface TransactionHistoryEntry {
  /**
   * Unique identifier for this history entry.
   *
   * When `crypto.randomUUID` is available this is a UUID v4. On older
   * runtimes that lack it, a collision-resistant fallback of the form
   * `<timestamp>-<random>` is used instead. Both formats are opaque
   * strings and are accepted by {@link loadJSON} on hydration.
   */
  id: string;
  /** The transaction hash this entry refers to. */
  hash: string;
  /** The ledger the transaction was included in, when known. */
  ledger?: number;
  /** Unix timestamp (ms) at which the entry was recorded. */
  timestamp: number;
  /** Arbitrary caller-supplied metadata attached to the entry. */
  metadata?: Record<string, unknown>;
}

/**
 * Generate a unique id for a {@link TransactionHistoryEntry}.
 *
 * Prefers `crypto.randomUUID()` (UUID v4) when the runtime exposes it.
 * Falls back to a timestamp + random suffix for older runtimes; the
 * fallback is documented on {@link TransactionHistoryEntry.id} and is
 * still accepted by {@link loadJSON} on hydration.
 */
export function generateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
