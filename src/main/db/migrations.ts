import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Db } from './connection'
import { DbError } from './errors'

/**
 * Seed list of migration 1, frozen inline. It must never track system-categories.ts: changing that
 * list must not change what migration 1 inserted on already-migrated databases.
 */
const MIGRATION1_SEED: readonly { id: string; name: string; kind: 'expense' | 'income' | 'transfer' }[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Income', kind: 'income' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Transfer', kind: 'transfer' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Uncategorized', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000100', name: 'Groceries', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000101', name: 'Dining', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000102', name: 'Transportation', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000103', name: 'Housing', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000104', name: 'Utilities', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000105', name: 'Healthcare', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000106', name: 'Entertainment', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000107', name: 'Shopping', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000108', name: 'Subscriptions', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000109', name: 'Travel', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000110', name: 'Education', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000111', name: 'Fees', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000112', name: 'Other', kind: 'expense' }
]

export interface Migration {
  version: number
  name: string
  up: (db: Db) => void
}

const AUDIT = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT`

const migration1 = (db: Db): void => {
  db.exec(`
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card')),
  institution TEXT, last4 TEXT, ${AUDIT});

CREATE TABLE categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id),
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','transfer')),
  is_system INTEGER NOT NULL DEFAULT 0, ${AUDIT});

CREATE TABLE imports (
  id TEXT PRIMARY KEY, file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf','csv')),
  file_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0, retained_file_path TEXT, ${AUDIT});

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description_raw TEXT NOT NULL,
  description_normalized TEXT, merchant TEXT,
  category_id TEXT REFERENCES categories(id),
  import_id TEXT REFERENCES imports(id),
  fingerprint TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('pdf','csv','manual')),
  confidence REAL,
  is_transfer INTEGER NOT NULL DEFAULT 0, ${AUDIT});
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_fingerprint ON transactions(fingerprint);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  month TEXT NOT NULL, amount_cents INTEGER NOT NULL, ${AUDIT});
CREATE UNIQUE INDEX idx_budgets_cat_month ON budgets(category_id, month) WHERE deleted_at IS NULL;

CREATE TABLE recurring_items (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL, next_due TEXT,
  category_id TEXT REFERENCES categories(id),
  is_subscription INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', ${AUDIT});

CREATE TABLE savings_goals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, target_cents INTEGER NOT NULL,
  target_date TEXT, current_cents INTEGER NOT NULL DEFAULT 0, ${AUDIT});

CREATE TABLE goal_contributions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES savings_goals(id),
  date TEXT NOT NULL, amount_cents INTEGER NOT NULL, ${AUDIT});

CREATE TABLE categorization_rules (
  id TEXT PRIMARY KEY, pattern TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  source TEXT NOT NULL CHECK (source IN ('system','learned','user')),
  weight REAL NOT NULL DEFAULT 1, ${AUDIT});

CREATE TABLE anomaly_flags (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  reason_code TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','confirmed')), ${AUDIT});

CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE auth (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  hash TEXT NOT NULL, salt TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0, lockout_until TEXT, ${AUDIT});

CREATE TABLE account_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL, balance_cents INTEGER NOT NULL, ${AUDIT});
CREATE INDEX idx_balances_account_date ON account_balances(account_id, date);
`)
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO categories (id,name,parent_id,kind,is_system,created_at,updated_at)
     VALUES (@id,@name,NULL,@kind,1,@now,@now)`
  )
  for (const c of MIGRATION1_SEED) ins.run({ ...c, now })
}

/**
 * Migration 2 (append-only; migration 1 is never edited).
 *
 *  - auth: replaced by a real single-row record (id = 1) with per-credential scrypt columns,
 *    lockout state, and CHECKs (at least one credential; each credential all-or-nothing). The
 *    old JSON-in-`hash` row is converted. Auth rows are hard-deleted on wipe (no tombstone), so
 *    the table has no deleted_at.
 *  - transactions: add transfer_link_id (replaces the 'transfer:<uuid>' fingerprint hack; legacy
 *    legs are backfilled and their fingerprint cleared) and CHECKs on is_transfer.
 *  - STRICT tables for every table with money columns (transactions, budgets, recurring_items,
 *    savings_goals, goal_contributions, account_balances): SQLite then rejects non-integer values in
 *    INTEGER columns, so cents can never be stored as floats or text. Done by table rebuild
 *    because CHECK/STRICT cannot be added to existing tables with ALTER.
 *  - anomaly_flags.reason (replaces the settings-table `anomaly_reason:<id>` workaround; old values
 *    are copied over and the settings rows removed).
 *  - indexes: transactions(import_id), transactions(account_id,date), transactions(transfer_link_id),
 *    anomaly_flags(transaction_id), categorization_rules(category_id), goal_contributions(goal_id),
 *    categories(parent_id), recurring_items(category_id).
 *
 * migrate() runs each migration with foreign_keys OFF (required for table rebuilds) and runs
 * PRAGMA foreign_key_check before commit.
 */
const AUDIT2 = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT`

function rebuild(db: Db, table: string, createSql: string, indexes: string[], select?: Record<string, string>): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  db.exec(createSql.replace('%T%', `${table}_new`))
  const targetCols = (db.prepare(`PRAGMA table_info(${table}_new)`).all() as { name: string }[]).map((c) => c.name)
  const insertCols = targetCols.filter((c) => cols.includes(c) || (select && c in select))
  const exprs = insertCols.map((c) => select?.[c] ?? c)
  db.exec(`INSERT INTO ${table}_new (${insertCols.join(',')}) SELECT ${exprs.join(',')} FROM ${table}`)
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`)
  for (const ix of indexes) db.exec(ix)
}

interface OldCred {
  salt: string
  hash: string
  keyLength: number
  cost: number
  blockSize: number
  parallelization: number
}

const migration2 = (db: Db): void => {
  // ---- auth
  const old = db.prepare("SELECT hash FROM auth WHERE deleted_at IS NULL ORDER BY (id='primary') DESC LIMIT 1").get() as
    | { hash: string }
    | undefined
  let rec: { pin: OldCred | null; password: OldCred | null; failureCount: number; lockoutUntil: number } | null = null
  if (old) {
    try {
      rec = JSON.parse(old.hash)
    } catch {
      throw new DbError('AUTH_RECORD_CORRUPT')
    }
  }
  db.exec(`
CREATE TABLE auth_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash TEXT, pin_salt TEXT, pin_key_length INTEGER, pin_cost INTEGER,
  pin_block_size INTEGER, pin_parallelization INTEGER,
  password_hash TEXT, password_salt TEXT, password_key_length INTEGER, password_cost INTEGER,
  password_block_size INTEGER, password_parallelization INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  lockout_until INTEGER NOT NULL DEFAULT 0 CHECK (lockout_until >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (pin_hash IS NOT NULL OR password_hash IS NOT NULL),
  CHECK ((pin_hash IS NULL AND pin_salt IS NULL AND pin_key_length IS NULL AND pin_cost IS NULL
          AND pin_block_size IS NULL AND pin_parallelization IS NULL)
      OR (pin_hash IS NOT NULL AND pin_salt IS NOT NULL AND pin_key_length IS NOT NULL AND pin_cost IS NOT NULL
          AND pin_block_size IS NOT NULL AND pin_parallelization IS NOT NULL)),
  CHECK ((password_hash IS NULL AND password_salt IS NULL AND password_key_length IS NULL AND password_cost IS NULL
          AND password_block_size IS NULL AND password_parallelization IS NULL)
      OR (password_hash IS NOT NULL AND password_salt IS NOT NULL AND password_key_length IS NOT NULL
          AND password_cost IS NOT NULL AND password_block_size IS NOT NULL AND password_parallelization IS NOT NULL))
) STRICT;`)
  if (rec && (rec.pin || rec.password)) {
    const t = new Date().toISOString()
    const c = (x: OldCred | null): (string | number | null)[] =>
      x ? [x.hash, x.salt, x.keyLength, x.cost, x.blockSize, x.parallelization] : [null, null, null, null, null, null]
    db.prepare(
      `INSERT INTO auth_new (id, pin_hash,pin_salt,pin_key_length,pin_cost,pin_block_size,pin_parallelization,
         password_hash,password_salt,password_key_length,password_cost,password_block_size,password_parallelization,
         failure_count, lockout_until, created_at, updated_at)
       VALUES (1, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`
    ).run(...c(rec.pin), ...c(rec.password), rec.failureCount ?? 0, rec.lockoutUntil ?? 0, t, t)
  }
  db.exec('DROP TABLE auth; ALTER TABLE auth_new RENAME TO auth;')

  // ---- strict rebuilds
  rebuild(
    db,
    'transactions',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN -1000000000000 AND 1000000000000),
  description_raw TEXT NOT NULL,
  description_normalized TEXT, merchant TEXT,
  category_id TEXT REFERENCES categories(id),
  import_id TEXT REFERENCES imports(id),
  fingerprint TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('pdf','csv','manual')),
  confidence REAL,
  is_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0,1)),
  transfer_link_id TEXT,
  ${AUDIT2},
  CHECK (transfer_link_id IS NULL OR is_transfer = 1)
) STRICT`,
    [
      'CREATE INDEX idx_transactions_date ON transactions(date)',
      'CREATE INDEX idx_transactions_account ON transactions(account_id)',
      'CREATE INDEX idx_transactions_account_date ON transactions(account_id, date)',
      'CREATE INDEX idx_transactions_category ON transactions(category_id)',
      'CREATE INDEX idx_transactions_fingerprint ON transactions(fingerprint)',
      'CREATE INDEX idx_transactions_import ON transactions(import_id)',
      'CREATE INDEX idx_transactions_transfer_link ON transactions(transfer_link_id) WHERE transfer_link_id IS NOT NULL'
    ],
    {
      transfer_link_id: "CASE WHEN is_transfer = 1 AND fingerprint LIKE 'transfer:%' THEN substr(fingerprint, 10) END",
      fingerprint: "CASE WHEN is_transfer = 1 AND fingerprint LIKE 'transfer:%' THEN NULL ELSE fingerprint END",
      is_transfer: 'CASE WHEN is_transfer <> 0 THEN 1 ELSE 0 END'
    }
  )
  rebuild(
    db,
    'budgets',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  month TEXT NOT NULL, amount_cents INTEGER NOT NULL, ${AUDIT2}) STRICT`,
    ['CREATE UNIQUE INDEX idx_budgets_cat_month ON budgets(category_id, month) WHERE deleted_at IS NULL']
  )
  rebuild(
    db,
    'recurring_items',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL, next_due TEXT,
  category_id TEXT REFERENCES categories(id),
  is_subscription INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', ${AUDIT2}) STRICT`,
    ['CREATE INDEX idx_recurring_category ON recurring_items(category_id)']
  )
  rebuild(
    db,
    'savings_goals',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, target_cents INTEGER NOT NULL,
  target_date TEXT, current_cents INTEGER NOT NULL DEFAULT 0, ${AUDIT2}) STRICT`,
    []
  )
  rebuild(
    db,
    'goal_contributions',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES savings_goals(id),
  date TEXT NOT NULL, amount_cents INTEGER NOT NULL, ${AUDIT2}) STRICT`,
    ['CREATE INDEX idx_goal_contrib_goal ON goal_contributions(goal_id)']
  )
  rebuild(
    db,
    'account_balances',
    `CREATE TABLE %T% (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL, balance_cents INTEGER NOT NULL, ${AUDIT2}) STRICT`,
    ['CREATE INDEX idx_balances_account_date ON account_balances(account_id, date)']
  )

  // ---- anomaly_flags.reason
  db.exec(`
ALTER TABLE anomaly_flags ADD COLUMN reason TEXT;
UPDATE anomaly_flags SET reason = (SELECT value FROM settings WHERE key = 'anomaly_reason:' || anomaly_flags.id);
DELETE FROM settings WHERE key LIKE 'anomaly_reason:%';
CREATE INDEX idx_anomaly_transaction ON anomaly_flags(transaction_id);
CREATE INDEX idx_rules_category ON categorization_rules(category_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
`)
}

/** Forward-only. Never edit a shipped migration; append a new one. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', up: migration1 },
  { version: 2, name: 'auth shape, transfer_link_id, strict money columns, indexes, flag reason', up: migration2 }
]

export interface MigrateOptions {
  /** Path of the db file (needed for backup). Omit for in-memory dbs. */
  dbPath?: string
  /** Defaults to <dbdir>/backups */
  backupDir?: string
  migrations?: Migration[]
}

export interface MigrateResult {
  applied: number[]
  backupPath: string | null
}

function currentVersion(db: Db): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  )
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  return row.v ?? 0
}

/**
 * Consistent copy of the live database using VACUUM INTO (a single read transaction, so it includes
 * WAL content and never races a checkpoint), then verified with integrity_check. A bad backup is
 * deleted and the migration is aborted (BACKUP_FAILED).
 */
function backupDatabase(db: Db, target: string): void {
  try {
    db.prepare('VACUUM INTO ?').run(target)
    const bk = new Database(target, { readonly: true })
    try {
      const res = bk.pragma('integrity_check', { simple: true })
      if (res !== 'ok') throw new Error('integrity_check failed')
    } finally {
      bk.close()
    }
  } catch (e) {
    try {
      rmSync(target, { force: true })
    } catch {
      /* ignore */
    }
    throw new DbError('BACKUP_FAILED', `BACKUP_FAILED: ${e instanceof Error ? e.message : 'unknown'}`)
  }
}

/**
 * Apply pending migrations in order, each in its own transaction (foreign keys off for the duration
 * so table rebuilds work; foreign_key_check must pass before commit). When the db already has applied
 * migrations and new ones are pending, a verified backup is written to the backups folder first.
 * Throws DB_NEWER_THAN_APP when the db was written by a newer app version.
 */
export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const all = [...(opts.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  const cur = currentVersion(db)
  const newest = all.length ? (all[all.length - 1] as Migration).version : 0
  if (cur > newest) {
    throw new DbError('DB_NEWER_THAN_APP', `DB_NEWER_THAN_APP: schema ${cur}, app supports ${newest}`)
  }
  const pending = all.filter((m) => m.version > cur)
  let backupPath: string | null = null
  if (pending.length === 0) return { applied: [], backupPath }

  if (cur > 0 && opts.dbPath && opts.dbPath !== ':memory:' && existsSync(opts.dbPath)) {
    const dir = opts.backupDir ?? join(dirname(opts.dbPath), 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = join(dir, `${basename(opts.dbPath)}.v${cur}.${stamp}.bak`)
    backupDatabase(db, backupPath)
  }

  const applied: number[] = []
  for (const m of pending) {
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        m.up(db)
        const bad = db.pragma('foreign_key_check') as unknown[]
        if (bad.length > 0) throw new Error(`migration ${m.version}: foreign_key_check failed`)
        db.prepare('INSERT INTO schema_version (version,name,applied_at) VALUES (?,?,?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        )
      })()
    } finally {
      db.pragma('foreign_keys = ON')
    }
    applied.push(m.version)
  }
  return { applied, backupPath }
}
