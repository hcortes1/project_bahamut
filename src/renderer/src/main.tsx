import { createRoot } from 'react-dom/client'

// Exercises the preload type declaration (src/preload/global.d.ts) in typecheck.
const appName: string = window.flujo.appName

createRoot(document.getElementById('root')!).render(<h1>{appName}</h1>)
