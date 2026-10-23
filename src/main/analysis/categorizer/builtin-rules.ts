import { SYSTEM_CATEGORIES } from '../../db/system-categories'

const idOf = (name: string): string => {
  const c = SYSTEM_CATEGORIES.find((x) => x.name === name)
  if (!c) throw new Error(`unknown system category ${name}`)
  return c.id
}

/** Keywords are matched as whole-word phrases against the normalized description. */
const GROUPS: readonly (readonly [category: string, keywords: readonly string[]])[] = [
  ['Groceries', [
    'WALMART', 'WAL MART', 'KROGER', 'SAFEWAY', 'TRADER JOE', 'TRADER JOES', 'WHOLE FOODS', 'ALDI', 'PUBLIX',
    'COSTCO', 'HEB', 'WEGMANS', 'FOOD LION', 'GIANT', 'SPROUTS', 'MEIJER', 'WINCO', 'INSTACART'
  ]],
  ['Dining', [
    'STARBUCKS', 'MCDONALDS', 'CHIPOTLE', 'SUBWAY', 'DUNKIN', 'PANERA', 'TACO BELL', 'WENDYS', 'BURGER KING',
    'CHICK FIL A', 'DOMINOS', 'PIZZA HUT', 'DOORDASH', 'UBER EATS', 'GRUBHUB', 'KFC', 'FIVE GUYS', 'PANDA EXPRESS',
    'OLIVE GARDEN', 'DENNYS', 'IHOP'
  ]],
  ['Transportation', [
    'UBER', 'LYFT', 'SHELL', 'CHEVRON', 'EXXON', 'EXXONMOBIL', 'BP', 'SUNOCO', 'MARATHON', 'SPEEDWAY', 'WAWA',
    'MTA', 'METRO', 'PARKING', 'EZPASS', 'GEICO', 'PROGRESSIVE', 'STATE FARM'
  ]],
  ['Housing', ['RENT', 'MORTGAGE', 'HOME DEPOT', 'LOWES', 'IKEA', 'HOA', 'APARTMENTS']],
  ['Utilities', [
    'COMCAST', 'XFINITY', 'VERIZON', 'ATT', 'AT T', 'TMOBILE', 'T MOBILE', 'SPECTRUM', 'PG E', 'PGE', 'CON EDISON',
    'DUKE ENERGY', 'WATER UTILITY', 'ELECTRIC', 'GAS COMPANY'
  ]],
  ['Healthcare', [
    'CVS', 'WALGREENS', 'RITE AID', 'PHARMACY', 'DENTAL', 'DENTIST', 'CLINIC', 'HOSPITAL', 'URGENT CARE', 'LABCORP',
    'QUEST DIAGNOSTICS', 'KAISER'
  ]],
  ['Entertainment', [
    'AMC', 'REGAL', 'CINEMARK', 'TICKETMASTER', 'STUBHUB', 'STEAM', 'PLAYSTATION', 'NINTENDO', 'XBOX', 'TWITCH',
    'BOWLING', 'TOPGOLF'
  ]],
  ['Shopping', [
    'AMAZON', 'TARGET', 'BEST BUY', 'EBAY', 'ETSY', 'NIKE', 'MACYS', 'NORDSTROM', 'TJ MAXX', 'TJMAXX', 'ROSS',
    'OLD NAVY', 'GAP', 'KOHLS', 'APPLE STORE', 'DOLLAR TREE', 'DOLLAR GENERAL', 'ULTA', 'SEPHORA'
  ]],
  ['Subscriptions', [
    'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY PLUS', 'HBO MAX', 'YOUTUBE PREMIUM', 'APPLE COM BILL', 'ICLOUD',
    'ADOBE', 'DROPBOX', 'OPENAI', 'PATREON', 'AUDIBLE', 'PEACOCK', 'PARAMOUNT', 'PLANET FITNESS', 'MICROSOFT 365'
  ]],
  ['Travel', [
    'DELTA AIR', 'UNITED AIRLINES', 'AMERICAN AIRLINES', 'SOUTHWEST', 'JETBLUE', 'AIRBNB', 'MARRIOTT', 'HILTON',
    'HYATT', 'EXPEDIA', 'BOOKING COM', 'HERTZ', 'AVIS', 'AMTRAK'
  ]],
  ['Education', ['TUITION', 'UNIVERSITY', 'COLLEGE', 'COURSERA', 'UDEMY', 'CHEGG', 'BOOKSTORE', 'STUDENT LOAN']],
  ['Fees', [
    'OVERDRAFT', 'ATM FEE', 'MONTHLY MAINTENANCE FEE', 'SERVICE FEE', 'LATE FEE', 'FOREIGN TRANSACTION FEE',
    'INTEREST CHARGE', 'ANNUAL FEE', 'NSF'
  ]],
  ['Income', ['PAYROLL', 'DIRECT DEP', 'DIRECT DEPOSIT', 'SALARY', 'INTEREST PAID', 'INTEREST EARNED', 'TAX REFUND']],
  ['Transfer', [
    'ONLINE BANKING TRANSFER', 'TRANSFER TO', 'TRANSFER FROM', 'ONLINE PAYMENT THANK YOU', 'PAYMENT THANK YOU',
    'CREDIT CARD PAYMENT', 'ZELLE'
  ]]
]

export interface BuiltinRule {
  keyword: string
  categoryId: string
}

export const BUILTIN_RULES: readonly BuiltinRule[] = GROUPS.flatMap(([cat, kws]) =>
  kws.map((keyword) => ({ keyword, categoryId: idOf(cat) }))
)

/** True when `phrase` occurs in `text` on whole-word boundaries (both already normalized). */
export function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `)
}

/** Longest matching keyword wins (most specific). */
export function matchBuiltin(normalized: string): BuiltinRule | null {
  let best: BuiltinRule | null = null
  for (const r of BUILTIN_RULES) {
    if (containsPhrase(normalized, r.keyword) && (!best || r.keyword.length > best.keyword.length)) best = r
  }
  return best
}
