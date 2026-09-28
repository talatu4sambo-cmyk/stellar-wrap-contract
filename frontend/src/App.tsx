import { FormEvent, useCallback, useState } from "react";
import {
  errorMessage,
  formatPeriod,
  formatTimestamp,
  parseHexBytes,
  shortAddress,
  validatePeriod,
} from "./lib/format";
import { connectWallet } from "./lib/freighter";
import { getWrap, loadDashboard, mintWrap, validateConfig } from "./lib/stellar";
import type {
  Dashboard,
  NetworkConfig,
  WalletSession,
  WrapRecord,
} from "./lib/types";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

type BusyAction = "connect" | "refresh" | "search" | "mint" | null;

type RecordState = "active" | "revoked" | "burned" | "expired" | "opted-out";

const STATE_LABELS: Record<RecordState, string> = {
  active: "Active",
  revoked: "Revoked",
  burned: "Burned",
  expired: "Expired",
  "opted-out": "Opted out",
};

const STATE_DESCRIPTIONS: Record<RecordState, string> = {
  active: "Valid soulbound wrap record held by this account.",
  revoked: "Revoked by the issuer; no longer valid.",
  burned: "Burned by the holder; permanently destroyed.",
  expired: "Past its validity period; no longer active.",
  "opted-out": "Holder opted out of this record.",
};

function resolveRecordState(record: WrapRecord): RecordState {
  if (record.revoked) {
    return "revoked";
  }
  if (record.burned) {
    return "burned";
  }
  if (record.optedOut) {
    return "opted-out";
  }
  if (record.expired) {
    return "expired";
  }
  return "active";
}

const initialDraft: NetworkConfig = {
  contractId: import.meta.env.VITE_STELLAR_CONTRACT_ID ?? "",
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL ?? DEFAULT_RPC_URL,
  networkPassphrase:
    import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE,
};

function WrapCard({
  record,
  title,
}: {
  record: WrapRecord;
  title: string;
}) {
  const state = resolveRecordState(record);
  return (
    <article className={`wrap-card wrap-card--${state}`}>
      <div className="wrap-card__heading">
        <div>
          <span className="eyebrow">{title}</span>
          <h3>{record.archetype}</h3>
        </div>
        <div className="wrap-card__badges">
          <span
            className={`state-badge state-badge--${state}`}
            title={STATE_DESCRIPTIONS[state]}
          >
            {STATE_LABELS[state]}
          </span>
          <span className="period-pill" title={`Raw period: ${record.period}`}>
            {formatPeriod(record.period)}
          </span>
        </div>
      </div>
      <p className="wrap-card__state-note">{STATE_DESCRIPTIONS[state]}</p>
      <dl className="record-grid">
        <div>
          <dt>Minted</dt>
          <dd>{formatTimestamp(record.timestamp)}</dd>
        </div>
        <div>
          <dt>Data hash</dt>
          <dd className="hash-value" title={record.dataHash}>
            {record.dataHash}
          </dd>
        </div>
      </dl>
      <p className="wrap-card__soulbound">
        Soulbound — this record cannot be transferred or sold.
      </p>
    </article>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export default function App() {
  const [draft, setDraft] = useState(initialDraft);
  const [config, setConfig] = useState<NetworkConfig | null>(null);
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [searchPeriod, setSearchPeriod] = useState("");
  const [searchResult, setSearchResult] = useState<
    WrapRecord | null | undefined
  >(undefined);
  const [mintPeriod, setMintPeriod] = useState("");
  const [archetype, setArchetype] = useState("");
  const [dataHash, setDataHash] = useState("");
  const [signature, setSignature] = useState("");
  const [transactionHash, setTransactionHash] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);

  const clearMessages = () => {
    setError("");
    setNotice("");
  };

  const refresh = useCallback(
    async (
      activeConfig: NetworkConfig | null = config,
      activeWallet: WalletSession | null = wallet,
    ) => {
      if (!activeConfig || !activeWallet) {
        return;
      }
      if (
        activeWallet.networkPassphrase !== activeConfig.networkPassphrase
      ) {
        throw new Error(
          `Freighter is on ${activeWallet.network}. Switch it to the configured network and reconnect.`,
        );
      }

      setDashboard(await loadDashboard(activeConfig, activeWallet.address));
    },
    [config, wallet],
  );

  const handleConfigure = (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    try {
      const nextConfig = validateConfig(draft);
      setConfig(nextConfig);
      setDashboard(null);
      setSearchResult(undefined);
      setTransactionHash("");
      setNotice("Contract configuration applied. Connect Freighter to continue.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const handleConnect = async () => {
    if (!config) {
      return;
    }
    clearMessages();
    setBusy("connect");
    try {
      const nextWallet = await connectWallet();
      if (nextWallet.networkPassphrase !== config.networkPassphrase) {
        throw new Error(
          `Freighter is on ${nextWallet.network}. Switch it to the configured network and reconnect.`,
        );
      }
      setWallet(nextWallet);
      await refresh(config, nextWallet);
      setNotice("Freighter connected.");
    } catch (cause) {
      setWallet(null);
      setDashboard(null);
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async () => {
    clearMessages();
    setBusy("refresh");
    try {
      await refresh();
      setNotice("On-chain data refreshed.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || !wallet) {
      return;
    }
    clearMessages();
    setSearchResult(undefined);
    setBusy("search");
    try {
      const period = validatePeriod(searchPeriod);
      setSearchResult(await getWrap(config, wallet.address, period));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleMint = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || !wallet) {
      return;
    }
    clearMessages();
    setTransactionHash("");
    setBusy("mint");
    try {
      const period = validatePeriod(mintPeriod);
      if (!/^[A-Za-z0-9_]{1,32}$/.test(archetype)) {
        throw new Error(
          "Archetype must be 1–32 letters, numbers, or underscores.",
        );
      }
      const hash = await mintWrap(config, wallet.address, {
        period,
        archetype,
        dataHash: parseHexBytes(dataHash, 32, "Data hash"),
        signature: parseHexBytes(signature, 64, "Admin signature"),
      });
      setTransactionHash(hash);
      setNotice("Wrap minted and confirmed on-chain.");
      await refresh(config, wallet);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Stellar Wrap home">
          <span className="brand__mark">W</span>
          <span>
            <strong>Stellar Wrap</strong>
            <small>On-chain registry</small>
          </span>
        </a>
        <div className="wallet-area">
          {wallet ? (
            <span className="wallet-chip" title={wallet.address}>
              <span className="status-dot" />
              {shortAddress(wallet.address)}
            </span>
          ) : (
            <button
              className="button button--primary"
              type="button"
              onClick={handleConnect}
              disabled={!config || isBusy}
            >
              {busy === "connect" ? "Connecting…" : "Connect Freighter"}
            </button>
          )}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero__copy">
            <span className="eyebrow">Proof that stays with you</span>
            <h1>Your Stellar story, wrapped on-chain.</h1>
            <p>
              Connect Freighter to inspect non-transferable wrap records and mint
              a signed new entry to the Stellar Wrap registry.
            </p>
          </div>
          <div className="hero__orb" aria-hidden="true">
            <span>WRAP</span>
          </div>
        </section>

        <div className="message-stack" aria-live="polite">
          {error ? <div className="message message--error">{error}</div> : null}
          {notice ? (
            <div className="message message--success">{notice}</div>
          ) : null}
        </div>

        <section className="panel setup-panel" aria-labelledby="setup-title">
          <div className="section-heading">
            <h2 id="setup-title">Contract configuration</h2>
            <p>Point the dashboard at a deployed Stellar Wrap contract.</p>
          </div>
          <form className="form-grid" onSubmit={handleConfigure}>
            <Field id="contract-id" label="Contract ID">
              <input
                id="contract-id"
                value={draft.contractId}
                onChange={(event) =>
                  setDraft({ ...draft, contractId: event.target.value })
                }
                placeholder="C…"
                autoComplete="off"
              />
            </Field>
            <Field id="rpc-url" label="Soroban RPC URL">
              <input
                id="rpc-url"
                value={draft.rpcUrl}
                onChange={(event) =>
                  setDraft({ ...draft, rpcUrl: event.target.value })
                }
                autoComplete="off"
              />
            </Field>
            <Field id="network-passphrase" label="Network passphrase">
              <input
                id="network-passphrase"
                value={draft.networkPassphrase}
                onChange={(event) =>
                  setDraft({ ...draft, networkPassphrase: event.target.value })
                }
                autoComplete="off"
              />
            </Field>
            <div className="form-actions">
              <button className="button button--primary" type="submit">
                Apply configuration
              </button>
            </div>
          </form>
        </section>

        {config && wallet ? (
          <section className="panel dashboard-panel" aria-labelledby="dashboard-title">
            <div className="section-heading">
              <h2 id="dashboard-title">Your wrap records</h2>
              <p>
                Records are soulbound: they cannot be transferred, sold, or moved
                to another account.
              </p>
            </div>
            <div className="dashboard-actions">
              <button
                className="button"
                type="button"
                onClick={handleRefresh}
                disabled={isBusy}
              >
                {busy === "refresh" ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {dashboard && dashboard.records.length > 0 ? (
              <div className="wrap-grid">
                {dashboard.records.map((record) => (
                  <WrapCard
                    key={record.period}
                    record={record}
                    title="Held record"
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <h3>No wrap records yet</h3>
                <p>
                  This account holds no wrap records for the configured contract.
                  Records are soulbound and cannot be transferred, so they only
                  appear here once minted to this address. Mint one below to get
                  started.
                </p>
              </div>
            )}
          </section>
        ) : null}

        {config && wallet ? (
          <section className="panel search-panel" aria-labelledby="search-title">
            <div className="section-heading">
              <h2 id="search-title">Look up a record</h2>
              <p>Fetch a single wrap record by its period.</p>
            </div>
            <form className="form-grid" onSubmit={handleSearch}>
              <Field
                id="search-period"
                label="Period"
                hint="Format YYYYMM, e.g. 202401."
              >
                <input
                  id="search-period"
                  value={searchPeriod}
                  onChange={(event) => setSearchPeriod(event.target.value)}
                  placeholder="202401"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </Field>
              <div className="form-actions">
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={isBusy}
                >
                  {busy === "search" ? "Searching…" : "Search"}
                </button>
              </div>
            </form>

            {searchResult === null ? (
              <div className="empty-state">
                <h3>No record for that period</h3>
                <p>
                  No wrap record exists for this account in the requested period.
                  Records are soulbound, so a record only exists if it was minted
                  directly to this address.
                </p>
              </div>
            ) : null}
            {searchResult ? (
              <WrapCard record={searchResult} title="Search result" />
            ) : null}
          </section>
        ) : null}

        {config && wallet ? (
          <section className="panel mint-panel" aria-labelledby="mint-title">
            <div className="section-heading">
              <h2 id="mint-title">Mint a wrap record</h2>
              <p>
                Submit a signed wrap entry. Minted records are soulbound and
                cannot be transferred.
              </p>
            </div>
            <form className="form-grid" onSubmit={handleMint}>
              <Field
                id="mint-period"
                label="Period"
                hint="Format YYYYMM, e.g. 202401."
              >
                <input
                  id="mint-period"
                  value={mintPeriod}
                  onChange={(event) => setMintPeriod(event.target.value)}
                  placeholder="202401"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </Field>
              <Field id="archetype" label="Archetype">
                <input
                  id="archetype"
                  value={archetype}
                  onChange={(event) => setArchetype(event.target.value)}
                  placeholder="Explorer"
                  autoComplete="off"
                />
              </Field>
              <Field id="data-hash" label="Data hash (32 bytes hex)">
                <input
                  id="data-hash"
                  value={dataHash}
                  onChange={(event) => setDataHash(event.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                />
              </Field>
              <Field id="signature" label="Admin signature (64 bytes hex)">
                <input
                  id="signature"
                  value={signature}
                  onChange={(event) => setSignature(event.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                />
              </Field>
              <div className="form-actions">
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={isBusy}
                >
                  {busy === "mint" ? "Minting…" : "Mint wrap"}
                </button>
              </div>
            </form>

            {transactionHash ? (
              <p className="transaction-hash">
                Transaction: <code>{transactionHash}</code>
              </p>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
