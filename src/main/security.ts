export interface UrlPolicyOptions {
  packaged: boolean
  /** ELECTRON_RENDERER_URL (dev server); ignored when packaged. */
  devUrl?: string | undefined
}

const ALWAYS_ALLOWED = new Set(['file:', 'devtools:', 'data:'])
const DEV_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Pure offline-policy predicate: true only for URLs the app may load. */
export function isAllowedUrl(raw: string, opts: UrlPolicyOptions): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (ALWAYS_ALLOWED.has(url.protocol)) return true
  if (opts.packaged || !opts.devUrl) return false
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false
  if (url.username !== '' || url.password !== '') return false
  if (!DEV_HOSTS.has(url.hostname)) return false
  let devPort: string
  try {
    devPort = new URL(opts.devUrl).port
  } catch {
    return false
  }
  return url.port === devPort
}

/** Scheme + host only; never path or query (they can hold sensitive data). */
export function describeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return u.host ? `${u.protocol}//${u.hostname}` : u.protocol
  } catch {
    return '[unparseable url]'
  }
}
