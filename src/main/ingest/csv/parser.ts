import Papa from 'papaparse'
import { detectDateOrder, looksLikeDate, parseDate, type DateOrder } from '../../../shared/dates'
import { parseMoneyToCents } from '../../../shared/money'
import { decodeCsvBytes, type CsvEncoding } from './decode'

export interface FieldDetection {
  /** Zero-based column index, or null when nothing was detected. */
  index: number | null
  /** 0..1 */
  confidence: number
}

export interface AmountMapping {
  mode: 'single' | 'split'
  amountIndex: number | null
  debitIndex: number | null
  creditIndex: number | null
  confidence: number
}

export interface CsvMapping {
  hasHeader: boolean
  /** Index in the parsed (non-empty-filtered) row array of the header row, -1 when headerless. */
  headerRowIndex: number
  date: FieldDetection
  description: FieldDetection
  amount: AmountMapping
  dateOrder: DateOrder
  /** True when every date was compatible with both MM/DD and DD/MM. */
  dateOrderAmbiguous: boolean
  /** True when some dates rule out MM/DD while others rule out DD/MM (mixed formats in one column). */
  dateOrderConflict: boolean
  /** Set true for files where positive single-column amounts are expenses (e.g. card exports). */
  invertSign: boolean
}

export interface NormalizedCsvRow {
  /** ISO date YYYY-MM-DD */
  date: string
  /** Negative = expense. */
  amountCents: number
  descriptionRaw: string
  confidence: number
  /** Zero-based index into the parsed row array (for review-screen tracing). */
  sourceRow: number
}

export interface SkippedCounts {
  blank: number
  /** Total/summary/balance rows and any preamble above the header. */
  summary: number
  /** Rows whose date or amount could not be parsed. */
  invalid: number
  total: number
}

export interface CsvParseOptions {
  /** Force a delimiter instead of auto-detecting. */
  delimiter?: string
  /** User overrides applied on top of the detected mapping. */
  mapping?: Partial<Omit<CsvMapping, 'amount'>> & { amount?: Partial<AmountMapping> }
}

export interface CsvParseResult {
  encoding: CsvEncoding
  delimiter: string
  headers: string[] | null
  mapping: CsvMapping
  rows: NormalizedCsvRow[]
  skipped: SkippedCounts
  /** Smallest mapping confidence across date/description/amount. */
  mappingConfidence: number
  warnings: string[]
}

const DATE_NAME = /date|posted|posting/i
const DESC_NAME = /desc|memo|payee|merchant|narrat|particulars|details?|name|reference/i
const AMOUNT_NAME = /amount|amt|value|sum/i
const DEBIT_NAME = /debit|withdraw|paid out|money out|charge/i
const CREDIT_NAME = /credit|deposit|paid in|money in/i
const BALANCE_NAME = /balance|\bbal\b/i
const HEADER_WORDS = [DATE_NAME, DESC_NAME, AMOUNT_NAME, DEBIT_NAME, CREDIT_NAME, BALANCE_NAME]

const SUMMARY_RE =
  /^\s*(grand\s+)?(sub)?totals?\b|^\s*(beginning|opening|starting|ending|closing|previous|new|statement)\s+balance|^\s*balance\s+(forward|brought|carried)|^\s*total\s+(credits|debits|deposits|withdrawals)|^\s*summary\b|^\s*(number|count)\s+of\b/i

/**
 * A row is a summary line only when its description is ENTIRELY a summary phrase. "TOTAL WINE & MORE",
 * "NEW BALANCE ATHLETICS" and "SUMMARY CAFE" are merchants and must never be dropped for their text.
 */
const SUMMARY_PHRASE_ONLY =
  /^\s*(?:(?:grand\s+)?(?:sub)?totals?|total\s+(?:credits|debits|deposits|withdrawals)|(?:beginning|opening|starting|ending|closing)\s+balance(?:\s+as\s+of\s+\S+)?|(?:previous|new|statement)\s+balance\s+as\s+of\s+\S+|balance\s+(?:forward|brought\s+forward|carried\s+forward))\s*:?\s*$/i

/** Low confidence assigned to a dated+amount row whose text merely STARTS like a summary phrase. */
const SUMMARY_LOOKALIKE_CONFIDENCE = 0.5

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const cell = (row: readonly string[], i: number | null): string => (i === null ? '' : (row[i] ?? '').trim())
const isBlankRow = (row: readonly string[]): boolean => row.every((c) => c.trim() === '')
const isNumericLike = (s: string): boolean => /^[\d.,\s$()+-]+$/.test(s)
/** Money that is clearly formatted as an amount (has decimals, a $ sign or parentheses). */
const isMoneyish = (s: string): boolean => parseMoneyToCents(s) !== null && /[.$()]/.test(s)

interface ColStats {
  index: number
  name: string
  nonEmpty: number
  fill: number
  dateFrac: number
  moneyFrac: number
  /** Fraction of values that parse as a number at all (includes bare integers like "-12"). */
  numFrac: number
  textFrac: number
  avgLen: number
}

function computeStats(rows: readonly string[][], headers: readonly string[] | null): ColStats[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), headers?.length ?? 0)
  const stats: ColStats[] = []
  for (let c = 0; c < width; c++) {
    let nonEmpty = 0
    let dates = 0
    let money = 0
    let numeric = 0
    let text = 0
    let lenSum = 0
    for (const r of rows) {
      const v = cell(r, c)
      if (v === '') continue
      nonEmpty++
      if (looksLikeDate(v)) dates++
      else if (isMoneyish(v)) {
        money++
        numeric++
      } else if (parseMoneyToCents(v) !== null) numeric++
      else if (!isNumericLike(v)) {
        text++
        lenSum += v.length
      }
    }
    stats.push({
      index: c,
      name: headers?.[c]?.trim() ?? '',
      nonEmpty,
      fill: rows.length ? nonEmpty / rows.length : 0,
      dateFrac: nonEmpty ? dates / nonEmpty : 0,
      moneyFrac: nonEmpty ? money / nonEmpty : 0,
      numFrac: nonEmpty ? numeric / nonEmpty : 0,
      textFrac: nonEmpty ? text / nonEmpty : 0,
      avgLen: text ? lenSum / text : 0
    })
  }
  return stats
}

function findHeaderRow(rows: readonly string[][]): number {
  const limit = Math.min(rows.length, 25)
  // Prefer a row naming a date column; fall back to any row with two keyword hits.
  for (const needDate of [true, false]) {
    for (let i = 0; i < limit; i++) {
      const r = rows[i] as string[]
      if (isBlankRow(r)) continue
      const lead = r.find((c) => c.trim() !== '') ?? ''
      // preamble line such as "Beginning balance as of ..." (but a row holding a real date is data)
      if (SUMMARY_RE.test(lead) && !r.some((c) => looksLikeDate(c.trim()))) continue
      if (r.some((c) => looksLikeDate(c.trim()) || isMoneyish(c.trim()))) {
        // A data row appears before any header: the file is headerless from here.
        break
      }
      const hits = r.filter((c) => HEADER_WORDS.some((re) => re.test(c))).length
      if (hits >= 2 && (!needDate || r.some((c) => DATE_NAME.test(c)))) return i
    }
  }
  // Single keyword on the very first non-empty row (e.g. a lone "Description" header).
  const first = rows.findIndex((r) => !isBlankRow(r))
  if (first >= 0) {
    const r = rows[first] as string[]
    const hits = r.filter((c) => HEADER_WORDS.some((re) => re.test(c))).length
    if (hits >= 1 && !r.some((c) => looksLikeDate(c.trim()) || isMoneyish(c.trim()))) return first
  }
  return -1
}

/** Detect the column mapping from parsed rows (no overrides applied). */
export function detectMapping(rows: readonly string[][]): CsvMapping {
  const headerRowIndex = findHeaderRow(rows)
  const hasHeader = headerRowIndex >= 0
  const headers = hasHeader ? (rows[headerRowIndex] as string[]).map((h) => h.trim()) : null
  const dataStart = hasHeader ? headerRowIndex + 1 : Math.max(0, rows.findIndex((r) => !isBlankRow(r)))
  const data = rows
    .slice(dataStart)
    .filter((r) => !isBlankRow(r) && !(SUMMARY_RE.test(r.find((c) => c.trim() !== '') ?? '') && !r.some((c) => looksLikeDate(c.trim()))))
  const stats = computeStats(data, headers)

  // ---- date ----
  let date: FieldDetection = { index: null, confidence: 0 }
  {
    let best = -Infinity
    for (const s of stats) {
      const named = DATE_NAME.test(s.name)
      if (s.dateFrac < 0.6 && !(named && s.nonEmpty > 0)) continue
      // When both a transaction date and a posting date exist, prefer the posting date: it is the date a
      // PDF statement row is fingerprinted on (see ParsedTransaction.date), so CSV and PDF imports agree.
      const score = s.dateFrac + (named ? 0.5 : 0) + (/post/i.test(s.name) ? 0.05 : 0)
      if (score > best) {
        best = score
        const conf = s.dateFrac >= 0.6 ? 0.55 * s.dateFrac + (named ? 0.45 : 0.25) : s.dateFrac * 0.5
        date = { index: s.index, confidence: clamp01(conf) }
      }
    }
  }

  const dateValues = date.index === null ? [] : data.map((r) => cell(r, date.index)).filter((v) => v !== '')
  const order = detectDateOrder(dateValues)
  if (order.ambiguous) date = { ...date, confidence: clamp01(date.confidence - 0.2) }
  // Mixed day/month orders in one column: never trustworthy, force it below any sane threshold.
  if (order.conflict) date = { ...date, confidence: Math.min(clamp01(date.confidence - 0.2), 0.4) }

  // ---- amount ----
  const usable = (s: ColStats): boolean => s.index !== date.index && !BALANCE_NAME.test(s.name)
  const moneyCols = stats.filter((s) => usable(s) && s.nonEmpty > 0 && s.moneyFrac >= 0.8)
  const named = (re: RegExp): ColStats | undefined =>
    stats.find((s) => usable(s) && re.test(s.name) && s.nonEmpty > 0 && s.moneyFrac >= 0.5)
  const debit = named(DEBIT_NAME)
  const credit = named(CREDIT_NAME)
  let amount: AmountMapping = { mode: 'single', amountIndex: null, debitIndex: null, creditIndex: null, confidence: 0 }
  if (debit && credit && debit.index !== credit.index) {
    amount = { mode: 'split', amountIndex: null, debitIndex: debit.index, creditIndex: credit.index, confidence: 0.95 }
  } else {
    const byName = stats.find(
      (s) => usable(s) && AMOUNT_NAME.test(s.name) && s.nonEmpty > 0 && (s.moneyFrac >= 0.5 || s.numFrac >= 0.8)
    )
    if (byName) {
      amount = { mode: 'single', amountIndex: byName.index, debitIndex: null, creditIndex: null, confidence: clamp01(0.5 + 0.45 * Math.max(byName.moneyFrac, byName.numFrac * 0.9)) }
    } else if (moneyCols.length >= 2 && moneyCols.slice(0, 2).every((s) => s.fill < 0.95)) {
      const [a, b] = moneyCols as [ColStats, ColStats]
      const both = data.filter((r) => cell(r, a.index) !== '' && cell(r, b.index) !== '').length
      if (both / Math.max(1, data.length) < 0.1) {
        amount = { mode: 'split', amountIndex: null, debitIndex: a.index, creditIndex: b.index, confidence: 0.5 }
      }
    }
    if (amount.confidence === 0 && moneyCols.length >= 1) {
      const first = moneyCols[0] as ColStats
      const conf = moneyCols.length === 1 ? 0.75 : 0.55
      amount = { mode: 'single', amountIndex: first.index, debitIndex: null, creditIndex: null, confidence: hasHeader ? conf : conf - 0.05 }
    }
  }

  // ---- description ----
  const taken = new Set<number | null>([date.index, amount.amountIndex, amount.debitIndex, amount.creditIndex])
  const textCols = stats.filter((s) => !taken.has(s.index) && !BALANCE_NAME.test(s.name) && s.textFrac >= 0.5 && s.dateFrac < 0.6)
  let description: FieldDetection = { index: null, confidence: 0 }
  if (textCols.length) {
    const scored = textCols.map((s) => ({ s, score: s.avgLen * (DESC_NAME.test(s.name) ? 1.5 : 1) })).sort((a, b) => b.score - a.score)
    const top = scored[0] as { s: ColStats; score: number }
    const runnerUp = scored[1]
    const nameHit = DESC_NAME.test(top.s.name)
    const conf = nameHit ? 0.95 : !runnerUp ? 0.85 : top.score >= runnerUp.score * 1.5 ? 0.8 : 0.6
    description = { index: top.s.index, confidence: conf }
  }

  return {
    hasHeader,
    headerRowIndex,
    date,
    description,
    amount,
    dateOrder: order.order,
    dateOrderAmbiguous: order.ambiguous,
    dateOrderConflict: order.conflict,
    invertSign: false
  }
}

/** Merge user overrides over a detected mapping; overridden fields get confidence 1. */
export function applyMappingOverrides(
  detected: CsvMapping,
  rows: readonly string[][],
  override: CsvParseOptions['mapping']
): CsvMapping {
  if (!override) return detected
  const m: CsvMapping = { ...detected, amount: { ...detected.amount } }
  if (override.hasHeader !== undefined) m.hasHeader = override.hasHeader
  if (override.headerRowIndex !== undefined) m.headerRowIndex = override.headerRowIndex
  if (override.invertSign !== undefined) m.invertSign = override.invertSign
  if (override.date) m.date = { index: override.date.index, confidence: override.date.confidence ?? 1 }
  if (override.description) m.description = { index: override.description.index, confidence: override.description.confidence ?? 1 }
  if (override.amount) m.amount = { ...m.amount, confidence: 1, ...override.amount }
  if (override.dateOrder) {
    m.dateOrder = override.dateOrder
    m.dateOrderAmbiguous = false
    m.dateOrderConflict = false
  } else if (override.date) {
    const start = m.hasHeader ? m.headerRowIndex + 1 : 0
    const vals = rows.slice(start).map((r) => cell(r, m.date.index)).filter((v) => v !== '')
    const o = detectDateOrder(vals)
    m.dateOrder = o.order
    m.dateOrderAmbiguous = o.ambiguous
    m.dateOrderConflict = o.conflict
  }
  return m
}

/** Convert raw rows into normalized transactions using a mapping. */
export function applyMapping(
  rows: readonly string[][],
  mapping: CsvMapping
): { rows: NormalizedCsvRow[]; skipped: SkippedCounts } {
  const out: NormalizedCsvRow[] = []
  const skipped: SkippedCounts = { blank: 0, summary: 0, invalid: 0, total: 0 }
  const firstData = mapping.hasHeader ? mapping.headerRowIndex + 1 : 0
  const m = mapping
  const rowConfBase = Math.min(m.date.confidence, m.description.confidence, m.amount.confidence)

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as string[]
    if (isBlankRow(r)) {
      skipped.blank++
      continue
    }
    if (i < firstData - (mapping.hasHeader ? 1 : 0)) {
      skipped.summary++ // preamble above the header
      continue
    }
    if (mapping.hasHeader && i === mapping.headerRowIndex) continue
    const descRaw = cell(r, m.description.index)
    const firstCell = r.find((c) => c.trim() !== '')?.trim() ?? ''
    const isSummaryText = SUMMARY_RE.test(descRaw) || SUMMARY_RE.test(firstCell)
    const phraseOnly = SUMMARY_PHRASE_ONLY.test(descRaw)
    const lookalike = descRaw !== '' && SUMMARY_RE.test(descRaw) && !phraseOnly
    const dateIso = m.date.index === null ? null : parseDate(cell(r, m.date.index), m.dateOrder)

    let cents: number | null = null
    if (m.amount.mode === 'split') {
      const d = parseMoneyToCents(cell(r, m.amount.debitIndex))
      const c = parseMoneyToCents(cell(r, m.amount.creditIndex))
      if (d !== null || c !== null) cents = (c === null ? 0 : Math.abs(c)) - (d === null ? 0 : Math.abs(d))
    } else {
      cents = parseMoneyToCents(cell(r, m.amount.amountIndex))
      if (cents !== null && m.invertSign) cents = -cents
    }

    if (dateIso === null && (isSummaryText || cents === null || cell(r, m.date.index) === '')) {
      skipped.summary++
      continue
    }
    if (dateIso === null) {
      skipped.invalid++
      continue
    }
    if (cents === null) {
      // Dated line without an amount: a balance/summary line ("Beginning balance as of ...") or junk.
      if (isSummaryText) skipped.summary++
      else skipped.invalid++
      continue
    }
    // Dated + amount rows are transactions. Only a description that is ENTIRELY a summary phrase drops one.
    if (phraseOnly) {
      skipped.summary++
      continue
    }
    const conf = descRaw === '' ? rowConfBase * 0.7 : rowConfBase
    out.push({
      date: dateIso,
      amountCents: cents,
      descriptionRaw: descRaw,
      confidence: clamp01(lookalike ? Math.min(conf, SUMMARY_LOOKALIKE_CONFIDENCE) : conf),
      sourceRow: i
    })
  }
  skipped.total = skipped.blank + skipped.summary + skipped.invalid
  return { rows: out, skipped }
}

/** Parse CSV bytes end to end: decode, split, detect mapping, normalize rows. */
export function parseCsv(bytes: Uint8Array, options: CsvParseOptions = {}): CsvParseResult {
  const { text, encoding } = decodeCsvBytes(bytes)
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    delimiter: options.delimiter ?? '',
    delimitersToGuess: [',', ';', '\t', '|']
  })
  const warnings: string[] = []
  for (const e of parsed.errors) {
    if (e.code === 'UndetectableDelimiter') continue
    warnings.push(`${e.code}${typeof e.row === 'number' ? ` (row ${e.row + 1})` : ''}`)
  }
  // Drop the single trailing empty record produced by a final newline.
  const rows = parsed.data.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : '')))
  while (rows.length && isBlankRow(rows[rows.length - 1] as string[]) && rows.length > 1) rows.pop()

  const detected = detectMapping(rows)
  const mapping = applyMappingOverrides(detected, rows, options.mapping)
  const headers = mapping.hasHeader && mapping.headerRowIndex >= 0 ? (rows[mapping.headerRowIndex] ?? null) : null
  const { rows: out, skipped } = applyMapping(rows, mapping)
  if (mapping.dateOrderAmbiguous) warnings.push('AMBIGUOUS_DATE_ORDER')
  if (mapping.dateOrderConflict) warnings.push('DATE_ORDER_CONFLICT')
  if (mapping.date.index === null) warnings.push('NO_DATE_COLUMN')
  if (mapping.description.index === null) warnings.push('NO_DESCRIPTION_COLUMN')
  if (mapping.amount.amountIndex === null && mapping.amount.debitIndex === null && mapping.amount.creditIndex === null) {
    warnings.push('NO_AMOUNT_COLUMN')
  }
  return {
    encoding,
    delimiter: parsed.meta.delimiter,
    headers,
    mapping,
    rows: out,
    skipped,
    mappingConfidence: Math.min(mapping.date.confidence, mapping.description.confidence, mapping.amount.confidence),
    warnings
  }
}
