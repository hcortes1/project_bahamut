/**
 * Description normalization (instructions 8): uppercase, strip store numbers,
 * dates, reference IDs and punctuation so the same merchant normalizes alike.
 *
 * Normalization feeds the dedupe fingerprint, so any behavior change MUST bump NORMALIZATION_VERSION
 * (fingerprints computed under another version never match, which fails safe: rows look new).
 * Bias: it is better to keep a distinguishing word than to collapse two merchants into one.
 */

/** Bump whenever normalizeDescription output can change for any input. */
export const NORMALIZATION_VERSION = 2

/** Well-known merchant aliases, matched against the start of the uppercased text (most specific first). */
const ALIASES: readonly (readonly [RegExp, string])[] = [
  // Prime membership/video is a different merchant line from marketplace purchases.
  [/^AMAZON PRIME(?![A-Z0-9])/, 'AMAZON PRIME'],
  [/^AMZN PRIME(?![A-Z0-9])/, 'AMAZON PRIME'],
  [/^(AMZN MKTP|AMAZON MKTPL|AMAZON MKTP|AMAZON\.COM|AMAZON PAYMENTS|AMZ\*|AMZN\*|AMAZON\*)/, 'AMAZON']
]

/** Bank-added transaction-type prefixes ("CHECKCARD 0113 STARBUCKS"). Optional MMDD / MM/DD follows. */
const BANK_PREFIX =
  /^(?:CHECKCARD|CHECK CARD|DEBIT CARD PURCHASE|DEBIT CARD|DEBIT PURCHASE|POS DEBIT|POS PURCHASE|POS WITHDRAWAL|PURCHASE AUTHORIZED ON|RECURRING CARD PURCHASE|RECURRING PAYMENT)\b[\s:]*(?:\d{2}\/\d{2}\b|\d{4}\b)?\s*/
/** "POS" alone is only a prefix when followed by a date or an asterisk (otherwise it may be a name). */
const POS_PREFIX = /^POS\s*(?:\*\s*|(?:\d{2}\/\d{2}|\d{4})\b\s*)/

/** Payment-processor prefixes that hide the real merchant. The text after the asterisk is kept. */
const PROCESSOR_PREFIX = /^(SQ|TST|SP|PP|PAYPAL|GOOGLE|CKO)\s*\*\s*/

const hasDigit = (t: string): boolean => /\d/.test(t)
const hasLetter = (t: string): boolean => /[A-Z]/.test(t)
/** A real ID shape: 3+ digits, or letters mixed with digits (e.g. A1B2C3D4E5, 2K4AB). */
const isIdShape = (t: string): boolean => /^\d{3,}$/.test(t) || (hasDigit(t) && hasLetter(t))

function stripDecorations(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function stripPrefixes(input: string): string {
  let s = input
  for (let i = 0; i < 4; i++) {
    const next = s.replace(BANK_PREFIX, '').replace(POS_PREFIX, '')
    if (next === s || next === '') break
    s = next
  }
  return s
}

export function normalizeDescription(raw: string): string {
  const upper = stripDecorations(raw)
  const stripped = stripPrefixes(upper)
  for (const [re, canonical] of ALIASES) {
    if (re.test(stripped)) return canonical
  }
  let s = stripped.replace(PROCESSOR_PREFIX, '')
  s = s
    // dates: 2024-01-05, 01/05, 01/05/24
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    // explicit store markers: "#1234", "STORE 12", "STR 4412"
    .replace(/#\s*\w+/g, ' ')
    .replace(/\b(?:STORE|STR)\b\.?\s*:?\s*\w*\d\w*/g, ' ')
    // reference keywords drop the next token only when it has a real ID shape ("NO 1 CHINESE" stays)
    .replace(/\b(?:NO|NUM|REF|REFERENCE|CONF|ID|TRACE|AUTH)\b\.?\s*:?\s*(\w+)/g, (m, tok: string) => (isIdShape(tok) ? ' ' : m))
    // "UBER *TRIP": the asterisk is only a separator; the aggregator sub-brand is kept
    .replace(/\*/g, ' ')
    // punctuation -> space
    .replace(/[^A-Z0-9 ]/g, ' ')
  const tokens = s
    .split(' ')
    .filter((t) => t !== '')
    // Drop ID-shaped tokens. A leading pure-digit token is part of the name ("1800 FLOWERS", "76 GAS").
    .filter((t, i) => !(/^\d{3,}$/.test(t) && i > 0) && !(hasDigit(t) && hasLetter(t) && t.length >= 6))
  const out = tokens.join(' ').trim()
  if (out !== '') return out
  const ascii = stripped.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  // Never collapse to empty: keep what the bank sent (also keeps non-Latin merchants distinct).
  return ascii !== '' ? ascii : upper
}
