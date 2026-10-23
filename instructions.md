# Flujo: Build Instructions

Build Flujo, a Windows desktop budgeting application for a single user, installed per-user on one machine. It runs fully offline, stores data in a local SQLite database, imports Bank of America PDF statements and CSV files, and produces a dashboard plus a budget optimizer.

Items marked **[ASSUMPTION]** were not specified and should be confirmed before they are treated as final.

---

## 1. Tech Stack

- **Shell:** Electron (latest stable), Windows 10/11 only
- **Language:** TypeScript (strict mode) in main, preload, and renderer
- **Runtime:** Node.js (the version bundled with Electron)
- **Database:** SQLite via `better-sqlite3` **[ASSUMPTION]**
- **Renderer UI:** React + Vite **[ASSUMPTION]**
- **Charts:** Chart.js **[ASSUMPTION]**
- **PDF parsing:** `pdfjs-dist` (text extraction with coordinates)
- **CSV parsing:** `papaparse`
- **Validation:** `zod` for all IPC payloads and parsed data
- **Packaging:** `electron-builder` producing an NSIS installer
- **Testing:** `vitest` for unit tests, Playwright for end-to-end tests
- **No Python anywhere.** All analysis and learning code is written in TypeScript and runs in a Node worker thread.

## 2. Hard Constraints

- **USD only.** No currency conversion.
- **Fully offline.** No external APIs, no telemetry, no update checks. Block all non-local outbound requests in Electron (`session.webRequest.onBeforeRequest`) and fail loudly in development if code attempts a network call.
- **Money is stored as integer cents.** Never use floating-point for amounts.
- **Dates are stored as ISO 8601 strings** (`YYYY-MM-DD` for transaction dates, full UTC timestamps for audit fields).
- **All primary keys are UUIDs** (kept so the sync stretch goal in section 6 can be added later without a migration).
- **Never log financial data, PINs, passwords, or file contents.** Logs may contain error codes, counts, and file names only.

## 3. Architecture

```
src/
  main/            Electron main process
    db/            schema, migrations, repositories
    auth/          PIN/password, lockout, session
    ingest/        pdf/, csv/, dedupe/, review queue
    analysis/      categorizer, optimizer, subscriptions, anomalies
    sync/          export/import bundles (STRETCH GOAL: do not create yet, see section 16)
    ipc/           typed IPC handlers
  preload/         contextBridge API (typed, minimal)
  renderer/        React UI (no Node access)
  shared/          types, zod schemas, constants
tests/
  fixtures/        SYNTHETIC statements and CSVs only (no real data)
```

**Electron security requirements (non-negotiable):**
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- The renderer talks to the main process only through a preload API exposing narrow, typed functions. Never expose `ipcRenderer` directly.
- Validate every IPC payload in main with zod. Treat the renderer as untrusted.
- Strict Content-Security-Policy (`default-src 'self'`), no remote content, no `eval`.
- Disable navigation and new-window creation; open no external URLs.
- Heavy work (PDF parsing, optimizer) runs in worker threads so the UI never blocks.

## 4. Authentication and Security

**Credentials**
- The user chooses PIN, password, or both. At least one is required. When both are enabled, both must be entered to unlock **[ASSUMPTION]**.
- PIN: 4 to 8 digits. Password: minimum 8 characters.
- Hash with `scrypt` (Node `crypto`) using a unique random salt per credential. Store only the hash, salt, and parameters. Never store plaintext.
- Compare with constant-time comparison.

**Lockout and session**
- Exponential backoff after repeated failures (for example, 5 failures then 30 seconds, doubling each further failure, capped at 15 minutes). Persist the failure count so restarting the app does not reset it.
- Auto-lock after a configurable idle period (default 5 minutes) and on window minimize if the user enables it. Locking clears sensitive data from renderer state.
- Changing or removing a credential requires entering the current one.
- Provide a "forgot credentials" path that is **honest about data loss**: the only recovery is wiping the local database. There is no backdoor.

**Encryption**
- The SQLite database is **not** encrypted at the application level. Protection at rest is intended to rely on Windows OS-level disk encryption (BitLocker / device encryption).
- **Backlog (section 16):** confirming that disk encryption is enabled on the user's machine, and the first-run notice about it, are deferred. Until then, do not claim the database is encrypted.
- Do not claim the app lock encrypts data: it is an access gate, not cryptographic protection.
- Sync bundles (section 6, stretch goal), if built, leave the machine's protected storage, so they **must** be encrypted with a user-supplied passphrase.

## 5. Data Model (SQLite)

Use a versioned migration system (a `schema_version` table, forward-only migrations). Enable `PRAGMA foreign_keys = ON` and WAL mode.

Core tables (all with `id` UUID, `created_at`, `updated_at`, and `deleted_at` for soft-delete/tombstones):

| Table | Purpose |
|---|---|
| `accounts` | name, type (checking, savings, credit_card), institution, last4 |
| `transactions` | account_id, date, amount_cents (negative = expense), description_raw, description_normalized, merchant, category_id, import_id, fingerprint, source (pdf, csv, manual), confidence |
| `categories` | name, parent_id, is_system |
| `budgets` | category_id, month (`YYYY-MM`), amount_cents |
| `recurring_items` | name, amount_cents, cadence, next_due, category_id, is_subscription, status |
| `savings_goals` | name, target_cents, target_date, current_cents |
| `goal_contributions` | goal_id, date, amount_cents |
| `imports` | file_name, file_type, file_hash, imported_at, row_count, retained_file_path (nullable) |
| `categorization_rules` | pattern, category_id, source (system, learned, user), weight |
| `anomaly_flags` | transaction_id, reason_code, severity, status (open, dismissed, confirmed) |
| `settings` | key/value (idle timeout, retention preference, etc.) |
| `auth` | credential hashes, salts, failure count, lockout-until |

**Net worth** is computed from account balances (recorded per account as dated balance snapshots in `account_balances`) and savings goals; it is a derived view, not a stored total.

## 6. Multi-Machine Support (STRETCH GOAL: BACKLOG)

**Status: stretch goal. Do not build, scaffold, or test any part of this section until the core app is complete and the user explicitly moves it out of the backlog (section 16).** The app currently targets one machine.

When built, the app must be usable on multiple machines **without any external service**. Because there are no APIs, sync is file-based **[ASSUMPTION]**:

- **Export bundle:** a single `.budgetsync` file containing changed or all records, encrypted with a user-supplied passphrase (AES-256-GCM, key derived with scrypt).
- **Import/merge:** merge by UUID using `updated_at` (last-write-wins per record). Deletions propagate through `deleted_at` tombstones.
- Before applying a merge, show a summary (added, updated, deleted counts) and require confirmation. Conflicts where both machines edited the same record after the last sync are listed for the user to resolve.
- Do **not** point two machines' live SQLite files at one shared cloud folder; this corrupts databases. State this in the UI help text.
- Each machine keeps its own app lock credentials. Credentials are never included in a sync bundle.
- A full backup/restore uses the same bundle format.

## 7. Import Pipeline

All imports flow through one pipeline: **select file → detect type → parse → normalize → categorize → dedupe → review → commit.** Nothing is written to `transactions` until the user confirms on the review screen.

### 7.1 Bank of America PDFs
- Supported: Bank of America statements (checking, savings, and credit card) **[ASSUMPTION]**. Build the parser behind a `StatementParser` interface (`canParse(doc)`, `parse(doc)`) so other banks can be added later.
- Use `pdfjs-dist` to extract text items with x/y coordinates; reconstruct rows by clustering on y-position and columns by x-position. Do not rely on raw text order.
- Rule-based parsing only (regex plus layout). No LLM or external service.
- Extract: statement period, account last4, beginning/ending balance, and each transaction (date, description, amount, running balance if present).
- **Validate arithmetic:** beginning balance plus extracted transactions must equal ending balance. A mismatch lowers confidence for the whole statement and is shown to the user.
- Handle multi-line descriptions, page breaks mid-table, repeated headers/footers, statements spanning a year boundary (infer the year from the period), and section headers (deposits, withdrawals, fees, checks paid).
- **Password-protected PDFs:** if `pdfjs` reports a password requirement, prompt the user for the password. Allow limited retries. Hold the password in memory only for that parse and never persist or log it.
- **Scanned/image-only PDFs:** out of scope **[ASSUMPTION]**. If a PDF yields no extractable text, show a clear message that OCR is not supported.
- Reject non-statement PDFs with a clear message rather than guessing.

### 7.2 CSV Files
- Auto-detect: encoding (UTF-8 with or without BOM, fall back to Windows-1252), delimiter, presence of a header row, and quoted fields.
- Auto-detect columns by header names and by sampling values:
  - **Date:** try common formats (`MM/DD/YYYY`, `YYYY-MM-DD`, `M/D/YY`, etc.); resolve ambiguity by scanning all rows (a value such as `13/05` rules out `MM/DD`).
  - **Description:** the longest free-text column.
  - **Amount:** either a single signed column, or separate debit/credit columns. Handle `(12.34)` negatives, `$` signs, thousands separators, and trailing `-`.
- Show the detected mapping in the review screen so the user can see and override it. Low-confidence detection requires explicit confirmation.
- Skip blank rows and summary/total rows; report how many were skipped.

### 7.3 Review Screen (required)
- Shown for every import. Lists each parsed transaction with its confidence, detected category, and any duplicate/anomaly markers.
- **Low-confidence rows** (below a configurable threshold, default 0.85) are highlighted and must be individually confirmed, edited, or excluded before commit.
- The user can bulk-edit categories, exclude rows, and edit dates/amounts/descriptions.
- Commit is atomic: one SQLite transaction. If it fails, nothing is imported.

### 7.4 Duplicate Handling
- Compute a fingerprint from `account_id + date + amount_cents + normalized description`.
- Also compare `file_hash` to detect re-importing the exact same file.
- Overlapping statements (for example, a CSV export covering dates already imported from a PDF) must be detected.
- **Prompt the user** for each suspected duplicate group: skip, import anyway, or "apply to all remaining." Show the existing and incoming rows side by side.
- Legitimate identical same-day transactions (two $4.50 coffees) must not be auto-collapsed. Use an occurrence index within a single file so they are treated as distinct, and only flag a duplicate when a prior import already contains the same count.

### 7.5 Retention of Imported Files
- After parsing, ask whether to keep the source file (the default is stored in the setting `retain_imports`). Kept files are copied to the app's data directory and linked from `imports.retained_file_path`.
- The user can delete a retained file at any time. On delete, ask separately whether to also delete the transactions that came from that import. Deleting a file never silently deletes transactions.
- Delete files by secure overwrite is not required; a normal delete is sufficient given OS-level disk encryption.

## 8. Categorization and Learning

- Pipeline order: user rules, then learned rules, then built-in merchant rules, then a statistical classifier, then "Uncategorized."
- Normalize descriptions first: uppercase, strip store numbers, dates, reference IDs, and punctuation (for example, `AMZN MKTP US*2K4...` becomes `AMAZON`).
- **Learning from corrections:** when the user changes a transaction's category, record it. After a correction:
  1. Create or strengthen a rule for that normalized merchant.
  2. Offer to re-apply the new category to other existing transactions from the same merchant.
  3. Feed the correction into the classifier.
- Classifier: a token-based Naive Bayes model implemented in TypeScript, trained only on the user's own corrected data and persisted in SQLite. It runs in-process; no Python and no external libraries are required.
- Low classifier confidence leaves the transaction flagged for review rather than guessing.
- Users can view, edit, and delete learned rules in a settings screen.

## 9. Features

1. **Accounts and manual transactions:** add, edit, delete; transfers between accounts must not count as income or expense.
2. **Budgets:** monthly budget per category; progress and over-budget indicators.
3. **Recurring bills:** track due dates and amounts; link detected subscriptions to them.
4. **Savings goals:** target amount, optional target date, contributions, and projected completion date from the contribution rate.
5. **Net worth:** current and historical from account balance snapshots and savings goals.
6. **Reports/export:** export transactions and summaries to CSV for a chosen date range.
7. **Dashboard** (section 10).
8. **Budget optimizer** (section 11).

## 10. Dashboard

Generated from imported CSV and PDF data (and manual entries); it refreshes automatically after any import commit. Filters: date range and account.

Required views:
- **Spending by month:** bar chart of total expenses per month.
- **Monthly trend:** line chart of spending over time, with a trailing average line.
- **Income vs. expenses:** per month, plus net (income minus expenses).
- **Spending by category:** breakdown for the selected range, with drill-down to transactions.
- **Top merchants:** ranked list for the selected range.

Requirements:
- Aggregate in SQL (grouped queries with indexes on `date`, `account_id`, `category_id`); never load all transactions into the renderer.
- Exclude transfers and soft-deleted rows from all totals.
- Handle empty states, a single month of data, and partial months (label the current month as partial).
- Chart colors must meet contrast requirements, and every chart must have a data-table fallback.

## 11. Budget Optimizer

**Input:** 6 to 12 months of transaction data. Require at least 6 complete months; if fewer exist, show how many months are available and disable the optimizer. Use the most recent 12 complete months when more are available.

**Implementation:** pure TypeScript statistical methods in a worker thread. No Python and no external services **[ASSUMPTION: "machine learning" is satisfied by statistical and learned models in TypeScript; see section 8 and the methods below]**.

**Outputs**
1. **Average spending:** average monthly spending overall and per category, using the median alongside the mean to resist outlier months.
2. **Highest category:** the category with the highest total and highest monthly average, with its share of total spending.
3. **Subscriptions:** detect recurring charges by grouping on normalized merchant, then testing for regular intervals (weekly, monthly, annual with a tolerance of a few days) and near-constant amounts. Report the merchant, amount, cadence, and annualized cost. Flag price increases and subscriptions with no recent usage signal where detectable. Let the user confirm or reject each one; rejections are remembered.
4. **Suspicious activity flags:** flag, never accuse. Rules and methods:
   - Amount far outside the user's normal range for that merchant or category (robust z-score using median and MAD, or IQR fences).
   - First-time merchant combined with a large amount.
   - Duplicate or near-duplicate charges from the same merchant within a short window.
   - Rapid bursts of charges within a short period.
   - Unexpected increase in a known subscription amount.
   - Each flag includes a human-readable reason and a severity. The user can mark it legitimate (suppresses similar future flags) or confirmed suspicious.
5. **Suggested budgets:** a recommended monthly budget per category derived from the median and trend, with a stated rationale. The user can accept any suggestion to create the corresponding budget.

**Edge cases:** months with zero data in a category, one-time large purchases (for example, a car repair) skewing averages, refunds and reversals (net them against the original category), and income-category transactions excluded from spending.

## 12. UX Requirements

- Lock screen on launch and after idle lock.
- First-run flow: set credentials, create an account, then import.
- Every destructive action (delete import, delete account, wipe data) requires confirmation that states exactly what will be deleted.
- Clear, specific error messages for parse failures (which file, which page, why).
- Fully keyboard-navigable; respect Windows high-contrast and dark mode.

## 13. Distribution (Windows)

- The app name is **Flujo** (`productName: Flujo`). Do not change it after real data exists, because it determines the data folder and installer identity.
- Build a **per-user** NSIS installer with `electron-builder` (no admin rights required) with publishing disabled (`--publish never`).
- Data lives in `%APPDATA%/Flujo/`: the database, retained imports, and logs.
- No auto-update **[ASSUMPTION]**; updates are installed manually from a new installer, and migrations run on first launch of the new version. Take an automatic database backup before running any migration.

## 14. Testing Requirements

- **Fixtures must be synthetic.** Never commit real statements or real financial data. Build realistic fake Bank of America-style PDFs and CSVs, including: multi-page statements, year-boundary statements, multi-line descriptions, password-protected PDFs, an image-only PDF, a corrupted PDF, and a non-statement PDF.
- Unit tests: parsers, amount/date parsing, fingerprinting, deduplication, categorizer, subscription detection, anomaly detection, scrypt auth. (Bundle encryption and merge logic tests belong to the sync stretch goal.)
- Property tests for money math (cents never drift, sums equal across views).
- End-to-end tests: import → review → commit → dashboard totals match; lockout behavior.
- Verify that no outbound network requests occur during any test.

## 15. Definition of Done

- All features in section 9 work offline on Windows 10 and 11.
- A balanced synthetic statement imports with arithmetic validated and no data written before confirmation.
- A re-import of the same file or an overlapping file triggers the duplicate prompt.
- Dashboard totals match a direct SQL sum of the underlying transactions.
- The optimizer refuses to run with fewer than 6 months of data and produces all five outputs with 6 to 12.
- Security checklist passes: context isolation on, node integration off, CSP set, IPC validated, no network calls, no sensitive data in logs.

---

## 16. Backlog (Do Not Build Without Explicit User Approval)

Items here are deferred. Claude must not start, scaffold, or partially implement any of them. Ask the user before moving an item out of the backlog.

1. **Multi-machine sync (stretch goal).** Everything in section 6: encrypted `.budgetsync` export/import bundles, merge by UUID, tombstones, conflict resolution, and the related tests. The database design (UUID keys, `updated_at`, `deleted_at`) is kept so this can be added later.
2. **Disk encryption verification.** Detecting whether BitLocker / Device Encryption is on, and the one-time first-run notice recommending it. The user is not yet sure whether the machine has it enabled.
3. **In-app backup/restore.** This was planned to reuse the sync bundle format, so it is deferred with item 1. Until it exists, the automatic pre-migration database backup (section 13) is the only in-app backup.
