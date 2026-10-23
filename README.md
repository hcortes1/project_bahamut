# Flujo

Offline Windows budgeting app (Electron + React + TypeScript, local SQLite). It imports Bank of America PDF statements and CSV files and shows a dashboard and a budget optimizer. Nothing leaves your machine. The app lock is an access gate, not encryption.

## Setup

1. Install Node.js 22 or newer (Node 20 will not load the database module) and npm.
2. Install the packages:
   ```
   npm install
   ```
3. Run the app in development:
   ```
   npm run dev
   ```
   Dev data is stored separately from the installed app (`%APPDATA%\Flujo-dev` on Windows).

No `.env` file or API keys are needed. Optional settings, development only: `FLUJO_USER_DATA_DIR` sets a custom data folder.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app in development |
| `npm run build` | Build into `out/` |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (vitest) |
| `npm run test:e2e` | Build and run Playwright end-to-end tests |
| `npm run package` | Build the Windows installer into `release/` |

Building the installer (`npm run package`) must be run on Windows. See `deploy.md` for details.

## Project layout

```
src/main/      Electron main process (database, auth, imports, analysis, IPC)
src/preload/   Typed bridge between the UI and the main process
src/renderer/  React UI
src/shared/    Types and validation schemas shared by both sides
design/        UI layout reference
```

Use only synthetic data in tests. Never commit real statements, databases, or `.env` files.
