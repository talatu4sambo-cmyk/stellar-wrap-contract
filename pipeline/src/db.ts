import initSqlJs, { SqlJsStatic, Database as SqlJsDatabase } from 'sql.js';
import type {
  EventRow,
  ContractStateRow,
  LedgerCursorRow,
  StorageEntry,
} from './types';

export class IndexerDB {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  static async create(dbPath?: string): Promise<IndexerDB> {
    const SQL: SqlJsStatic = await initSqlJs();
    let db: SqlJsDatabase;
    if (dbPath) {
      const fs = await import('fs');
      try {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
      } catch {
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }
    return new IndexerDB(db);
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS contract_events (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ledger_seq INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        failed_call INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_contract_ledger
      ON contract_events(contract_id, ledger_seq)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_type
      ON contract_events(event_type)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS wrap_records (
        contract_id TEXT NOT NULL,
        user TEXT NOT NULL,
        period INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        data_hash TEXT NOT NULL,
        archetype TEXT NOT NULL,
        fsm_state INTEGER NOT NULL,
        fsm_updated_at INTEGER NOT NULL,
        ledger_seq INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (contract_id, user, period)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wraps_user
      ON wrap_records(contract_id, user)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wraps_period
      ON wrap_records(contract_id, period)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_state (
        contract_id TEXT NOT NULL,
        user TEXT NOT NULL,
        wrap_count INTEGER NOT NULL DEFAULT 0,
        latest_period INTEGER,
        alias_hash TEXT,
        slash_count INTEGER NOT NULL DEFAULT 0,
        is_slashed INTEGER NOT NULL DEFAULT 0,
        periods_json TEXT NOT NULL DEFAULT '[]',
        ledger_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (contract_id, user)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS contract_state (
        contract_id TEXT PRIMARY KEY,
        admin TEXT,
        admin_pubkey TEXT,
        pending_admin TEXT,
        migration_version INTEGER NOT NULL DEFAULT 0,
        is_paused INTEGER NOT NULL DEFAULT 0,
        total_wrap_count INTEGER NOT NULL DEFAULT 0,
        total_revoked INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        slash_threshold INTEGER NOT NULL DEFAULT 3,
        ledger_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS storage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL,
        ledger_seq INTEGER NOT NULL,
        key_variant TEXT NOT NULL,
        key_json TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        durability TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_ledger
      ON storage_snapshots(contract_id, ledger_seq)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS ledger_cursor (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        last_processed_ledger INTEGER NOT NULL DEFAULT 0,
        last_event_ledger INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Idempotency ledger: records which events have already been applied so
    // that replays, backfills, and retries cannot double-apply derived state.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS applied_events (
        event_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ledger_seq INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_applied_events_contract
      ON applied_events(contract_id, ledger_seq)`);
  }

  private exec(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
  }

  private fetchOne(sql: string, params: unknown[] = []): Record<string, unknown> | null {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let row: Record<string, unknown> | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  private fetchAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // ─── Idempotency ────────────────────────────────────────────────────

  /**
   * Returns true if this event has not yet been applied and atomically
   * records it as applied. Callers must skip derived-state writes when this
   * returns false, which makes replay/backfill/retry safe at the key level.
   */
  markEventApplied(event: {
    id: string;
    contract_id: string;
    event_type: string;
    ledger_seq: number;
  }): boolean {
    const existing = this.fetchOne(
      `SELECT event_id FROM applied_events WHERE event_id = ?`,
      [event.id],
    );
    if (existing) return false;
    this.exec(
      `INSERT OR IGNORE INTO applied_events (event_id, contract_id, event_type, ledger_seq)
       VALUES (?, ?, ?, ?)`,
      [event.id, event.contract_id, event.event_type, event.ledger_seq],
    );
    return true;
  }

  isEventApplied(eventId: string): boolean {
    const row = this.fetchOne(
      `SELECT event_id FROM applied_events WHERE event_id = ?`,
      [eventId],
    );
    return row !== null;
  }

  getAppliedEventIds(contractId: string): string[] {
    const rows = this.fetchAll(
      `SELECT event_id FROM applied_events WHERE contract_id = ? ORDER BY ledger_seq ASC`,
      [contractId],
    ) as { event_id: string }[];
    return rows.map((r) => r.event_id);
  }

  // ─── Ledger cursor ──────────────────────────────────────────────────

  /**
   * Reads the durable cursor for a contract. Returns null when no cursor has
   * been persisted yet, which signals a first run (callers fall back to
   * START_LEDGER).
   */
  getLedgerCursor(contractId: string): LedgerCursorRow | null {
    const row = this.fetchOne(
      `SELECT * FROM ledger_cursor WHERE contract_id = ?`,
      [contractId],
    );
    return (row as unknown as LedgerCursorRow) ?? null;
  }

  /**
   * Persists the last fully-processed ledger together with the derived data
   * for that ledger in a single transaction, so the cursor and the data it
   * describes can never disagree across a restart.
   */
  commitLedger(
    contractId: string,
    lastProcessedLedger: number,
    lastEventLedger: number,
    applyDerived: () => void,
  ): void {
    this.db.run('BEGIN');
    try {
      applyDerived();
      this.exec(
        `INSERT INTO ledger_cursor (id, contract_id, last_processed_ledger, last_event_ledger, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           last_processed_ledger = excluded.last_processed_ledger,
           last_event_ledger = excluded.last_event_ledger,
           updated_at = datetime('now')`,
        [contractId, contractId, lastProcessedLedger, lastEventLedger],
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  /**
   * Guards against a persisted cursor that is ahead of the chain's current
   * ledger (e.g. a reset/reorged network). Refuses to proceed instead of
   * spinning forever waiting for ledgers that will never arrive.
   */
  assertCursorNotAhead(contractId: string, chainLedger: number): void {
    const cursor = this.getLedgerCursor(contractId);
    if (cursor && cursor.last_processed_ledger > chainLedger) {
      throw new Error(
        `Persisted cursor for ${contractId} is at ledger ${cursor.last_processed_ledger}, ` +
          `ahead of the chain's current ledger ${chainLedger}. Refusing to proceed; ` +
          `the database may be from a different network or the chain was reset.`,
      );
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────

  insertEvent(event: {
    id: string;
    contract_id: string;
    event_type: string;
    ledger_seq: number;
    tx_hash: string;
    topics_json: string;
    data_json: string;
    failed_call: boolean;
  }): void {
    this.exec(
      `INSERT OR IGNORE INTO contract_events
        (id, contract_id, event_type, ledger_seq, tx_hash, topics_json, data_json, failed_call)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.contract_id, event.event_type, event.ledger_seq, event.tx_hash, event.topics_json, event.data_json, event.failed_call ? 1 : 0],
    );
  }

  getEventsByLedgerRange(
    contractId: string,
    startLedger: number,
    endLedger: number,
    limit: number = 1000,
  ): EventRow[] {
    return this.fetchAll(
      `SELECT * FROM contract_events
       WHERE contract_id = ? AND ledger_seq >= ? AND ledger_seq <= ?
       ORDER BY ledger_seq ASC
       LIMIT ?`,
      [contractId, startLedger, endLedger, limit],
    ) as unknown as EventRow[];
  }

  getLatestEventLedger(contractId: string

/* … truncated 1946 chars — edit only what you need near the top … */
