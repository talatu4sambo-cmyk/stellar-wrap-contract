export type NetworkConfig = {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
};

export type WalletSession = {
  address: string;
  network: string;
  networkPassphrase: string;
};

export type ContractHealth = {
  initialized: boolean;
  hasAdmin: boolean;
  hasSigningKey: boolean;
};

/**
 * Lifecycle state of a wrap record. The contract supports revoke, burn,
 * opt-out and expiration, so a record is more than just "exists".
 */
export type WrapRecordState =
  | "active"
  | "revoked"
  | "burned"
  | "expired"
  | "opted-out";

export type WrapRecord = {
  timestamp: bigint;
  dataHash: string;
  archetype: string;
  /** Raw period as stored on-chain, in `YYYYMM` form. */
  period: bigint;
  /**
   * Current lifecycle state of the record. Optional so existing callers that
   * only know a record exists keep working; treat a missing value as "active".
   */
  state?: WrapRecordState;
  /**
   * Records are soulbound: they cannot be transferred between accounts.
   * Kept on the record so the UI can surface this without extra lookups.
   */
  soulbound?: boolean;
};

/**
 * Human-readable label for a record state, suitable for badges and lists.
 */
export const WRAP_RECORD_STATE_LABELS: Record<WrapRecordState, string> = {
  active: "Active",
  revoked: "Revoked",
  burned: "Burned",
  expired: "Expired",
  "opted-out": "Opted out",
};

/**
 * Format a raw `YYYYMM` period into a readable form (e.g. "March 2024")
 * while keeping the raw value available to callers.
 */
export function formatWrapPeriod(period: bigint): string {
  const raw = period.toString().padStart(6, "0");
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    return raw;
  }
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type Dashboard = {
  balance: bigint;
  health: ContractHealth;
  latestWrap: WrapRecord | null;
};

export type MintInput = {
  period: bigint;
  archetype: string;
  dataHash: Uint8Array;
  signature: Uint8Array;
};
