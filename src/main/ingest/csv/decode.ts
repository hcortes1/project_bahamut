export type CsvEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252'

export interface DecodedText {
  text: string
  encoding: CsvEncoding
}

/** Windows-1252 code points for bytes 0x80-0x9F (0 = undefined byte, kept as the C1 control). */
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178
]

/**
 * Decode Windows-1252 explicitly: some Node builds alias the "windows-1252"
 * TextDecoder label to ISO-8859-1, which leaves 0x80-0x9F as invisible controls.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) {
      const cp = CP1252_HIGH[b - 0x80] ?? 0
      out += String.fromCharCode(cp === 0 ? b : cp)
    } else {
      out += String.fromCharCode(b)
    }
  }
  return out
}

/** Decode CSV bytes: UTF-8 with/without BOM, UTF-16 with BOM, else Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252' }
  }
}
