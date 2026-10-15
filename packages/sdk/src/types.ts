import type { Transaction, rpc, xdr } from '@stellar/stellar-sdk';
import type { ISorobanRpcClient } from './RpcClient.js';
import type {
  FeeStroops,
  HistoryEntryId,
  NetworkPassphrase,
  RpcUrl,
  StellarPublicKey,
  TxHash,
  XdrBase64,
} from './branded-types.js';

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

/** Configuration options for a SorobanResurrect instance. */
export interface SorobanResurrectConfig {
  rpcUrl: RpcUrl | string;
  networkPassphrase?: NetworkPassphrase | string;
  rpcClient?: ISorobanRpcClient;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  restoreFeeMultiplier?: number;
  maxRestoreFeeStroops?: FeeStroops | string | number;
  maxSequenceRetries?: number;
  archiveDetectionMethod?: 'simulation' | 'direct';
  archiveDetectionChunkSize?: number;
  archiveDetectionConcurrency?: number;
  maxBatchSize?: number;
  archiveDetectionFallback?: boolean;
  enableSimulationCache?: boolean;
  simulationCacheTtlMs?: number;
  simulationCacheMaxSize?: number;
  useSSE?: boolean;
  ttlWatchIntervalMs?: number;
  ttlWatchThreshold?: number;
  ttlWatchThresholdLedgers?: number;
  ttlWatchAutoExtend?: boolean;
  restoreTxMemo?: import('@stellar/stellar-sdk').Memo;
  restoreTxMemoText?: string;
  logger?: Logger;
  persistHistory?: HistoryPersistenceOptions;
  rpcTimeoutMs?: number;
  rpcRetryCount?: number;
  rpcRetryBackoffMs?: number;
  rpcCircuitBreakerThreshold?: number;
  rpcCircuitBreakerCooldownMs?: number;
  maxRestoreTxSizeBytes?: number;
  restoreSizeWarnRatio?: number;
  throwOnRestoreSizeLimit?: boolean;
}

/** Wallet features the SDK may use to select safe signing flows. */
export interface WalletCapabilities {
  signAuthEntry?: boolean;
  feeBump?: boolean;
  hardware?: boolean;
  maxOperations?: number;
}

/** Wallet interface used for transaction signing and account lookup. */
export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<StellarPublicKey | string>;
  signTransaction(
    tx: XdrBase64 | string,
    opts?: { networkPassphrase?: NetworkPassphrase | string; network?: string },
  ): Promise<XdrBase64 | string>;
  getNetwork?(): Promise<string>;
  capabilities?: WalletCapabilities;
}

/** Extended wallet adapter with explicit hardware connection lifecycle. */
export interface HardwareWalletAdapter extends WalletAdapter {
  readonly type: 'ledger' | 'trezor';
  readonly capabilities: WalletCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAppVersion(): Promise<string>;
}

/** Configuration for a Ledger adapter. */
export interface LedgerAdapterConfig {
  transport?: unknown;
  accountIndex?: number;
}

/** Configuration for a Trezor adapter. */
export interface TrezorAdapterConfig {
  trezorConnect?: unknown;
  manifest: { email: string; appUrl: string };
  accountIndex?: number;
}

/** Sponsor interface for a fee-bump transaction. */
export interface FeeBumpSponsor {
  getPublicKey(): Promise<StellarPublicKey | string>;
  signFeeBump(
    txXdr: XdrBase64 | string,
    opts?: { networkPassphrase?: NetworkPassphrase | string },
  ): Promise<XdrBase64 | string>;
}

/** Optional fee-bump transaction configuration. */
export interface FeeBumpConfig {
  sponsor: FeeBumpSponsor;
  feeBumpFee?: FeeStroops | string;
}

/** A ledger entry identified as archived. */
export interface ArchivedLedgerEntry {
  key: xdr.LedgerKey;
  keyBase64: XdrBase64 | string;
}

/** Soroban RPC simulation response union. */
export type SimulateResponse = rpc.Api.SimulateTransactionResponse;

/** Result of a restore-and-submit workflow. */
export interface ResurrectResult {
  success: boolean;
  originalTxHash?: TxHash | string;
  restoreTxHash?: TxHash | string;
  archivedKeysDetected: number;
  error?: string;
  errorCode?: import('./errors.js').ResurrectErrorCode;
  dryRun?: boolean;
  dryRunResult?: DryRunResult;
  historyId?: HistoryEntryId | string;
  sequenceRetries?: number;
}

/** Detailed output of a dry-run simulation. */
export interface DryRunResult {
  wouldNeedRestore: boolean;
  archivedKeysDetected: number;
  archivedKeys: ArchivedLedgerEntry[];
  estimatedRestoreFee?: FeeStroops;
  simulationError?: string;
}

/** Options for submitting a transaction with automatic archive restoration. */
export interface SubmitWithRestoreOptions {
  transaction: Transaction;
  wallet: WalletAdapter;
  feeBumpConfig?: FeeBumpConfig;
  restoreTxMemo?: import('@stellar/stellar-sdk').Memo;
  restoreTxMemoText?: string;
  onSigningRestore?: () => void;
  onSubmittingRestore?: () => void;
  onSigningOriginal?: () => void;
  onRestoreNeeded?: (archivedKeys: ArchivedLedgerEntry[]) => void;
  onRestoreSubmitted?: (txHash: TxHash | string) => void;
  onRestoreConfirmed?: (txHash: TxHash | string) => void;
  onOriginalSubmitted?: (txHash: TxHash | string) => void;
  onRestoreFailed?: (error: string) => void;
}

/** Options for restoring caller-supplied ledger keys. */
export interface RestoreKeysOptions {
  onSigningRestore?: () => void;
  onSubmittingRestore?: () => void;
  onRestoreSubmitted?: (hash: TxHash | string) => void;
  onRestoreConfirmed?: (hash: TxHash | string) => void;
}

/** State labels emitted during restore workflows. */
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

/** Events emitted by SorobanResurrect. */
export interface SorobanResurrectEvents {
  stateChange: RestoreStateInfo;
  restoreNeeded: ArchivedLedgerEntry[];
  restoreSubmitted: TxHash | string;
  restoreConfirmed: TxHash | string;
  originalSubmitted: TxHash | string;
  restoreComplete: ResurrectResult;
  error: string;
  networkChanged: { rpcUrl: string; networkPassphrase: string };
  ttlLow: unknown[];
  ttlExtended: { restoreTxHash: TxHash | string; entries: unknown[] };
}

/** Storage interface used by transaction history persistence. */
export interface HistoryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
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
