import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from './api'

/** Load data on mount (and on `reload`). `error` is a user-safe message. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    load().then(
      (d) => {
        if (live) {
          setData(d)
          setError(null)
        }
      },
      (e: unknown) => {
        if (live) setError(errorMessage(e))
      }
    )
    return () => {
      live = false
    }
    // `load` is a fresh closure each render by design; reload is driven by `tick`.
  }, [tick, ...deps])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload }
}
