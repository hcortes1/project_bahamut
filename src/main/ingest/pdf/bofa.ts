import { inferStatementDate } from '../../../shared/dates'
import { isMoney, isoDate, parseCents } from './cents'
import { PdfIngestError } from './errors'
import type {
  AccountType,
  ArithmeticValidation,
  Cell,
  ParsedStatement,
  ParsedTransaction,
  ParseWarning,
  PdfTextDocument,
  Row,
  StatementParser
} from './types'

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
const MONTH_IDX = MONTHS.toLowerCase().split('|')
const PERIOD_WORDS = new RegExp(
  `(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})\\s*(?:to|through|-|\\u2013|\\u2014)\\s*(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})`,
  'i'
)
const PERIOD_NUM = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:to|through|-|–|—)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/
const DATE_CELL = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/
const TRAILING_MONEY = /(\(?-?\$?-?\d[\d,]*\.\d{2}\)?-?)\s*$/
const ACCOUNT_NUMBER = /account\s*(?:number|#|no\.?)\s*:?\s*([0-9Xx*\s-]{8,})/i

/** Page furniture that can never be part of a transaction, even when it wraps. */
const ALWAYS_IGNORE = [/^page\s+\d+(\s+of\s+\d+)?$/i, /member\s+fdic/i, /^continued( on (the )?next page)?$/i, /^this page intentionally/i]
/**
 * Total/balance lines and the bank name. These are skipped UNLESS the row is a wrapped description line
 * (no amount, aligned with the description column) of the transaction above, e.g. "TOTAL WINE & MORE".
 */
const SOFT_IGNORE = [/^bank of america/i, /^(sub)?total\b/i, /^(beginning|ending|previous|new) balance\b/i]

type SectionKind = 'deposit' | 'withdrawal' | 'check' | 'fee' | 'payment' | 'purchase' | 'skip' | 'unknown'

function sectionOf(text: string): Exclude<SectionKind, 'unknown'> | null {
  const t = text
    .toLowerCase()
    .replace(/[-–—(]*\s*\(?continued\)?\s*$/, '')
    .trim()
  if (/^deposits and other (additions|credits)/.test(t)) return 'deposit'
  if (/^withdrawals and other (subtractions|debits)/.test(t)) return 'withdrawal'
  if (/^checks?( paid)?$/.test(t)) return 'check'
  if (/^(service )?fees?( charged)?$/.test(t) || /^(interest|fees) charged/.test(t)) return 'fee'
  if (/^payments? and other credits/.test(t)) return 'payment'
  if (/^purchases( and adjustments)?$/.test(t)) return 'purchase'
  if (/^(daily ledger balances|account summary|summary|important information|interest charge calculation)/.test(t)) return 'skip'
  return null
}

const SIGN: Record<SectionKind, 1 | -1 | 0> = {
  deposit: 1,
  withdrawal: -1,
  check: -1,
  fee: -1,
  payment: 1,
  purchase: -1,
  skip: 0,
  unknown: 0
}

interface Columns {
  descX: number
  refX: number | null
  amountRight: number | null
  balanceRight: number | null
}

function lastMoney(row: Row): number | null {
  const m = TRAILING_MONEY.exec(row.text)
  return m ? parseCents(m[1]!) : null
}

function parsePeriod(rows: Row[]): { start: string; end: string } | null {
  for (const r of rows) {
    const w = PERIOD_WORDS.exec(r.text)
    if (w) {
      const s = isoDate(Number(w[3]), MONTH_IDX.indexOf(w[1]!.toLowerCase()) + 1, Number(w[2]))
      const e = isoDate(Number(w[6]), MONTH_IDX.indexOf(w[4]!.toLowerCase()) + 1, Number(w[5]))
      if (s && e) return { start: s, end: e }
    }
    const n = PERIOD_NUM.exec(r.text)
    if (n) {
      const s = isoDate(Number(n[3]), Number(n[1]), Number(n[2]))
      const e = isoDate(Number(n[6]), Number(n[4]), Number(n[5]))
      if (s && e) return { start: s, end: e }
    }
  }
  return null
}

interface HeaderMeta {
  last4: string | null
  beginning: number | null
  ending: number | null
}

function readHeaderMeta(rows: Row[]): HeaderMeta {
  const meta: HeaderMeta = { last4: null, beginning: null, ending: null }
  for (const r of rows) {
    if (meta.last4 === null) {
      const m = ACCOUNT_NUMBER.exec(r.text)
      const digits = m?.[1]?.replace(/\D/g, '') ?? ''
      if (digits.length >= 4) meta.last4 = digits.slice(-4)
    }
    if (meta.beginning === null && /^(beginning balance|previous balance)\b/i.test(r.text)) meta.beginning = lastMoney(r)
    if (meta.ending === null && /^(ending balance|new balance)\b/i.test(r.text)) meta.ending = lastMoney(r)
  }
  return meta
}

/** Card vs savings vs checking from several independent signals, not one keyword. */
function detectAccountType(doc: PdfTextDocument, rows: Row[]): AccountType {
  const joined = rows.map((r) => r.text).join('\n')
  const firstPage = doc.pages[0]?.rows ?? []
  const stop = firstPage.findIndex((r) => /^(account summary|beginning balance|previous balance|deposits and other)/i.test(r.text))
  const head = firstPage.slice(0, stop > 0 ? stop : 14).map((r) => r.text).join('\n')
  const cardSections = rows.some((r) => /^(payments? and other credits|purchases and adjustments)\b/i.test(r.text))
  if (
    (/previous balance/i.test(joined) && /new balance/i.test(joined)) ||
    /credit card|cash rewards|visa signature|mastercard/i.test(head) ||
    (cardSections && /credit limit|minimum payment due/i.test(joined))
  ) {
    return 'credit_card'
  }
  if (/savings/i.test(head) && !/checking|banking/i.test(head)) return 'savings'
  return 'checking'
}

/** Assigns a data row's cells to columns by x-position (nearest right edge for numbers). */
function classify(cells: Cell[], cols: Columns | null) {
  const description: string[] = []
  const money: Cell[] = []
  let postDate: string | null = null
  for (const [i, c] of cells.entries()) {
    if (i === 0) continue // transaction date
    if (cols && c.x < cols.descX - 2 && DATE_CELL.test(c.text)) {
      postDate ??= c.text // posting date (card statements)
      continue
    }
    if (isMoney(c.text)) money.push(c)
    else if (cols?.refX != null && c.x >= cols.refX - 2) continue // reference number column
    else description.push(c.text)
  }
  let amount: Cell | null = null
  let balance: Cell | null = null
  if (cols?.amountRight != null && cols.balanceRight != null) {
    for (const c of money) {
      if (Math.abs(c.xEnd - cols.amountRight) <= Math.abs(c.xEnd - cols.balanceRight)) amount ??= c
      else balance ??= c
    }
  } else {
    amount = money[money.length - 1] ?? null
  }
  return { description, amount, balance, postDate }
}

/** Split a two-up Checks line (Date | Check # | Amount | Date | Check # | Amount) into its triplets. */
function splitTriplets(cells: Cell[]): Cell[][] | null {
  const starts = cells.flatMap((c, i) => (DATE_CELL.test(c.text) ? [i] : []))
  if (starts.length < 2) return null
  return starts.map((s, k) => cells.slice(s, starts[k + 1] ?? cells.length))
}

/** Single-cell, digit-free, short title left of the description column: an unrecognised section heading. */
function isUnknownHeading(row: Row, descX: number | null): boolean {
  if (row.cells.length !== 1) return false
  const c = row.cells[0]!
  if (/\d/.test(c.text) || c.text.length < 3 || c.text.length > 60) return false
  if (c.text.split(' ').length > 8) return false
  return descX === null || c.x < descX - 4
}

/** Furniture = non-dated, money-free single lines printed at the same place on 2+ pages. */
function repeatedFurniture(doc: PdfTextDocument): Set<string> {
  const seen = new Map<string, Set<number>>()
  for (const p of doc.pages) {
    for (const r of p.rows) {
      if (DATE_CELL.test(r.cells[0]?.text ?? '') || r.cells.some((c) => isMoney(c.text))) continue
      const key = `${r.text}|${Math.round(r.y / 3)}`
      const pages = seen.get(key) ?? new Set<number>()
      pages.add(p.pageNumber)
      seen.set(key, pages)
    }
  }
  return new Set([...seen].filter(([, pages]) => pages.size >= 2).map(([k]) => k))
}

export const bofaParser: StatementParser = {
  id: 'bofa',

  canParse(doc) {
    const rows = doc.pages.flatMap((p) => p.rows)
    if (!/bank of america/i.test(rows.map((r) => r.text).join('\n')) || parsePeriod(rows) === null) return false
    const meta = readHeaderMeta(rows)
    return meta.last4 !== null || meta.beginning !== null || meta.ending !== null
  },

  parse(doc: PdfTextDocument): ParsedStatement {
    const rows = doc.pages.flatMap((p) => p.rows)
    const period = parsePeriod(rows)
    if (!period) {
      throw new PdfIngestError('NOT_A_STATEMENT', doc.fileName, 'No statement period was found.')
    }

    // ---- header metadata -------------------------------------------------------------------
    const { last4, beginning, ending } = readHeaderMeta(rows)
    const accountType = detectAccountType(doc, rows)
    const isCard = accountType === 'credit_card'

    // ---- transactions ----------------------------------------------------------------------
    const txs: ParsedTransaction[] = []
    let columns: Columns | null = null
    let sawTableHeader = false
    let section: SectionKind = 'unknown'
    let unparsed = 0
    let inferredDebits = 0 // debit-section amounts printed without a sign (sign came from the heading)
    const furniture = repeatedFurniture(doc)

    const resolveDate = (cell: string): string | null => {
      const m = DATE_CELL.exec(cell)
      if (!m) return null
      const mo = Number(m[1])
      const d = Number(m[2])
      if (m[3]) return isoDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mo, d)
      return inferStatementDate(mo, d, period.start, period.end)
    }

    /** Printed sign wins; the section only decides unsigned values. Card statements print charges positive. */
    const signed = (text: string, kind: SectionKind): number => {
      const printed = parseCents(text)!
      if (isCard) return -printed
      if (/[-+()]/.test(text)) return printed
      const s = SIGN[kind]
      if (s === 0) return printed
      if (s < 0) inferredDebits++
      return s * Math.abs(printed)
    }

    for (const page of doc.pages) {
      let last: ParsedTransaction | null = null // continuation never crosses a page break
      for (const row of page.rows) {
        const text = row.text
        if (ALWAYS_IGNORE.some((re) => re.test(text))) continue
        const cells = row.cells
        const first = cells[0]
        if (!first) continue

        // Column header row (repeated on every page).
        const dateHdrs = cells.filter((c) => /^(transaction |trans\.? |posting |post )?date$/i.test(c.text))
        const amountHdr = cells.find((c) => /^amount$/i.test(c.text))
        if (dateHdrs.length > 0 && amountHdr) {
          const descHdr = cells.find((c) => /^description$/i.test(c.text))
          const balHdr = cells.find((c) => /balance/i.test(c.text))
          const refHdr = cells.find((c) => /^(reference|ref)/i.test(c.text))
          const lastDate = dateHdrs[dateHdrs.length - 1]!
          const afterDate = cells.find((c) => c.x > lastDate.xEnd)
          columns = {
            descX: descHdr?.x ?? afterDate?.x ?? lastDate.xEnd + 10,
            refX: refHdr?.x ?? null,
            amountRight: amountHdr.xEnd,
            balanceRight: balHdr?.xEnd ?? null
          }
          sawTableHeader = true
          last = null
          continue
        }

        const isDated = DATE_CELL.test(first.text)
        const hasMoney = cells.some((c) => isMoney(c.text))

        if (!isDated && !hasMoney) {
          // Wrapped description line of the transaction above (one or more cells, aligned with the column).
          const descX = columns?.descX ?? first.x
          if (last && cells.every((c) => c.x >= descX - 4) && Math.abs(first.x - descX) <= 4) {
            last.description = `${last.description} ${text}`.replace(/\s+/g, ' ').trim()
            continue
          }
          if (SOFT_IGNORE.some((re) => re.test(text))) continue
          const sec = sectionOf(text)
          if (sec) {
            section = sec
            last = null
            continue
          }
          if (!furniture.has(`${text}|${Math.round(row.y / 3)}`) && isUnknownHeading(row, columns?.descX ?? null)) {
            section = 'unknown' // a heading we do not recognise: do not guess its sign
            last = null
          }
          continue
        }

        if (!isDated) {
          // Money without a leading date: a total/balance line, or a row we could not place.
          if (SOFT_IGNORE.some((re) => re.test(text))) continue
          if (section !== 'unknown' && section !== 'skip') unparsed++
          continue
        }

        // ---- dated rows ----
        if (section === 'skip') continue
        if (section === 'unknown') {
          if (hasMoney) unparsed++
          last = null
          continue
        }

        // Two-up Checks layout: two Date | Check # | Amount triplets per line.
        const triplets = section === 'check' ? splitTriplets(cells) : null
        if (triplets) {
          last = null
          for (const t of triplets) {
            const date = resolveDate(t[0]!.text)
            const amounts = t.filter((c) => isMoney(c.text))
            if (!date || amounts.length !== 1) {
              unparsed++
              continue
            }
            const num = t
              .slice(1)
              .filter((c) => !isMoney(c.text))
              .map((c) => c.text.replace(/\*+$/, ''))
              .join(' ')
              .trim()
            txs.push({
              date,
              transactionDate: null,
              description: /^\d+$/.test(num) ? `Check ${num}` : num,
              amountCents: signed(amounts[0]!.text, section),
              balanceCents: null,
              section,
              page: page.pageNumber,
              confidence: 1
            })
          }
          continue
        }

        const c = classify(cells, columns)
        const txDate = resolveDate(first.text)
        if (!txDate || c.amount === null) {
          unparsed++
          last = null
          continue
        }
        let date = txDate
        let transactionDate: string | null = null
        if (c.postDate) {
          const post = resolveDate(c.postDate)
          if (post) {
            date = post // canonical date = posting date (see ParsedTransaction.date)
            transactionDate = txDate
          }
        }
        let description = c.description.join(' ').replace(/\s+/g, ' ').trim()
        if (section === 'check' && /^\d+\*?$/.test(description)) description = `Check ${description.replace(/\*$/, '')}`
        last = {
          date,
          transactionDate,
          description,
          amountCents: signed(c.amount.text, section),
          balanceCents: c.balance ? parseCents(c.balance.text) : null,
          section,
          page: page.pageNumber,
          confidence: 1
        }
        txs.push(last)
      }
    }

    if (!sawTableHeader || (txs.length === 0 && beginning === null && ending === null)) {
      throw new PdfIngestError('NOT_A_STATEMENT', doc.fileName, 'No transaction table or account balances were found.')
    }

    // ---- arithmetic validation -------------------------------------------------------------
    const sum = txs.reduce((s, t) => s + t.amountCents, 0)
    const checked = beginning !== null && ending !== null
    const computed = beginning === null ? null : isCard ? beginning - sum : beginning + sum
    const validation: ArithmeticValidation = {
      checked,
      ok: checked && computed === ending,
      expectedEndingCents: ending,
      computedEndingCents: computed,
      differenceCents: checked && computed !== null && ending !== null ? computed - ending : null
    }

    const warnings: ParseWarning[] = []
    let confidence = 1
    if (!checked) {
      warnings.push({ code: 'BALANCES_MISSING', message: 'Beginning or ending balance could not be read; totals were not verified.' })
      confidence = Math.min(confidence, 0.5)
    } else if (!validation.ok) {
      warnings.push({ code: 'ARITHMETIC_MISMATCH', message: 'Beginning balance plus transactions does not equal the ending balance.' })
      confidence = Math.min(confidence, 0.4)
    }
    if (unparsed > 0) {
      warnings.push({ code: 'UNPARSED_ROWS', message: 'Some table rows could not be parsed.', count: unparsed })
      confidence = Math.min(confidence, 0.7)
    }
    if (txs.length === 0) {
      warnings.push({ code: 'NO_TRANSACTIONS', message: 'No transactions were found.' })
      confidence = Math.min(confidence, 0.5)
    }
    // Card statements print charges as positive numbers (opposite of a bank ledger), and a checking
    // statement whose debits are mostly unsigned relies on the section heading for the sign. Either way
    // the sign convention is inferred, so every row needs a human confirmation.
    if (isCard || (txs.length > 0 && inferredDebits * 2 > txs.length)) {
      warnings.push({
        code: 'SIGN_CONVENTION_UNCERTAIN',
        message: 'Amount signs were inferred from the statement layout; confirm that spending is negative.'
      })
      confidence = Math.min(confidence, 0.6)
    }
    if (last4 === null) warnings.push({ code: 'LAST4_MISSING', message: 'Account number was not found.' })
    for (const t of txs) t.confidence = confidence

    return {
      parserId: 'bofa',
      fileName: doc.fileName,
      accountType,
      last4,
      periodStart: period.start,
      periodEnd: period.end,
      beginningBalanceCents: beginning,
      endingBalanceCents: ending,
      transactions: txs,
      confidence,
      validation,
      warnings
    }
  }
}
