/** A positioned text run from pdf.js. Coordinates are in PDF points with the origin at the TOP-left. */
export interface TextItem {
  str: string
  x: number
  xEnd: number
  y: number
  height: number
}

export interface Cell {
  text: string
  x: number
  xEnd: number
}

/** A visual line reconstructed by y-clustering; cells are x-ordered and merged across tiny gaps. */
export interface Row {
  page: number
  y: number
  height: number
  cells: Cell[]
  text: string
}

export interface PdfPage {
  pageNumber: number
  width: number
  height: number
  items: TextItem[]
  rows: Row[]
}

export interface PdfTextDocument {
  fileName: string
  pages: PdfPage[]
}

export type AccountType = 'checking' | 'savings' | 'credit_card'

export interface ParsedTransaction {
  /**
   * ISO YYYY-MM-DD. This is always the POSTING date (the date the bank settled it), also for credit cards
   * that print both a transaction and a posting date. CSV imports use the posted-date column the same way,
   * and the dedupe fingerprint is computed on this value, so a PDF and a CSV of the same activity agree.
   */
  date: string
  /** Card statements only: the transaction (purchase) date when it is printed separately, else null. */
  transactionDate: string | null
  description: string
  /** Signed integer cents from the account holder's view: money in is positive, spending is negative. */
  amountCents: number
  /** Running balance after the transaction when the statement prints one. */
  balanceCents: number | null
  section: string
  page: number
  /** 0..1; equals the statement confidence (a mismatch lowers the whole statement). */
  confidence: number
}

export interface ParseWarning {
  code:
    | 'ARITHMETIC_MISMATCH'
    | 'BALANCES_MISSING'
    | 'UNPARSED_ROWS'
    | 'NO_TRANSACTIONS'
    | 'LAST4_MISSING'
    | 'SIGN_CONVENTION_UNCERTAIN'
  /** Fixed text only, never statement contents. */
  message: string
  count?: number
}

export interface ArithmeticValidation {
  ok: boolean
  /** False when beginning/ending balance could not be read. */
  checked: boolean
  expectedEndingCents: number | null
  computedEndingCents: number | null
  /** computed - expected, in cents. */
  differenceCents: number | null
}

export interface ParsedStatement {
  parserId: string
  fileName: string
  accountType: AccountType
  last4: string | null
  periodStart: string
  periodEnd: string
  /** For credit cards, balances are amounts owed (positive = debt). */
  beginningBalanceCents: number | null
  endingBalanceCents: number | null
  transactions: ParsedTransaction[]
  /** 0..1. */
  confidence: number
  validation: ArithmeticValidation
  warnings: ParseWarning[]
}

export interface StatementParser {
  readonly id: string
  canParse(doc: PdfTextDocument): boolean
  parse(doc: PdfTextDocument): ParsedStatement
}
