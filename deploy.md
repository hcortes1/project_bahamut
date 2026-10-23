# deploy.md: Deploying Flujo on Windows

This guide is written for someone who has never built or deployed an Electron or TypeScript application. Read it fully before the first build.

**Rules for Claude:** Follow `workflow.md` at all times. Deployment configuration is written by Sonnet, reviewed through the REV workflow, and uses Context7 for current documentation. Claude never pushes to GitHub without approval, never pushes `.md` files, and must ask the user before running an installer or changing anything outside the project folder.

---

## Index

| ID | Section |
|---|---|
| [A](#a-run-locally-or-install-a-built-version) | Run locally or install a built version? |
| [B](#b-plain-language-glossary) | Plain-language glossary |
| [C](#c-prerequisites) | Prerequisites |
| [D](#d-decisions-already-made) | Decisions already made |
| [E](#e-pre-deployment-checklist) | Pre-deployment checklist |
| [F](#f-build-the-installer) | Build the installer |
| [G](#g-install-and-first-run) | Install and first run |
| [H](#h-data-location-backups-and-uninstalling) | Data location, backups, and uninstalling |
| [I](#i-updating-the-app) | Updating the app |
| [J](#j-things-you-can-skip-for-one-machine) | Things you can skip for one machine |
| [K](#k-troubleshooting) | Troubleshooting |
| [L](#l-backlog-and-known-risks) | Backlog and known risks |

---

## A. Run Locally or Install a Built Version?

There are two ways to run an Electron app on your own computer:

| | Dev mode (`npm start` or similar) | Installed build |
|---|---|---|
| What it is | Runs straight from the project folder with developer tooling | A normal Windows program with a Start menu entry |
| Needs a terminal and the project folder | Yes | No |
| Tests the same code path you will use daily | No | Yes |
| Good for | Building and testing features | Daily use with real financial data |

**Recommendation: develop in dev mode, but use an installed build for real data.** Several problems only appear in the packaged app (see section K): native modules (the SQLite library), file paths inside the packed app, and the PDF reader's worker file all behave differently once packaged. An app that works in dev mode can fail after packaging.

Because Flujo runs on one machine and is not distributed to anyone else, "deployment" here just means **building an installer on your own computer and installing it yourself**. You do not need to publish anything, buy a certificate, or set up updates (section J).

## B. Plain-Language Glossary

- **Electron:** A framework that wraps a web page (your React UI) and a Node.js program into a desktop app.
- **Main process / renderer:** The main process is the Node.js side (database, file access, PDF parsing). The renderer is the window the user sees. They talk through a controlled channel called IPC.
- **TypeScript:** JavaScript with types. It is compiled to JavaScript before running (`build`).
- **Node.js / npm:** The runtime and the package manager that downloads libraries. `package.json` lists the project's libraries and commands.
- **Native module:** A library containing compiled code, such as `better-sqlite3`. It must be built for the exact version of Electron you use.
- **electron-builder:** The tool that packs your app into a Windows installer.
- **NSIS:** The installer format electron-builder produces (a normal `Setup.exe`).
- **ASAR:** The archive that Electron packs your app's files into. Some files, such as native modules, must be kept outside it.
- **Code signing:** A digital signature proving who made the installer. Not needed for personal use (section J).

## C. Prerequisites

Install these on the machine that will build the app:

1. **Windows 10 or 11.**
2. **Node.js (LTS version).** Confirm with `node --version`.
3. **Git.** Confirm with `git --version`.
4. **Visual Studio Build Tools** with the "Desktop development with C++" workload. This is only needed if the SQLite library has no prebuilt binary for your Electron version. Install it if the build fails with a compiler error (section K).
5. **Claude Code**, with the Context7 MCP, Stitch MCP, and any frontend skill/agent that `workflow.md` requires.

You do not need to know TypeScript to follow this guide. Claude writes the code under `workflow.md`.

## D. Decisions Already Made

| Decision | Choice |
|---|---|
| App name | **Flujo** (`productName: Flujo`). Do not change it once real data exists: it determines the data folder and installer identity, and renaming makes the app look for a different folder and appear to have lost your data. |
| Install type | **Per-user.** No admin rights needed; installs under your user profile. |
| Multi-machine sync | **Stretch goal (backlog).** Not part of the first release. |
| Disk encryption verification | **Backlog.** Not part of the first release (see section L for the risk this leaves). |

## E. Pre-Deployment Checklist

Complete every item before building the installer you will trust with real data.

- [ ] All tasks meet the Definition of Done in `workflow.md` (DOD): Sonnet wrote the code, Opus reviewed it, Playwright evidence was gathered, and tests pass.
- [ ] `git ls-files '*.md'` returns nothing and no secrets or real financial data are in the repo.
- [ ] Dev mode and the installed app use **separate data folders** so test imports never mix with real data. In dev, Claude sets a different `userData` path when the app is not packaged.
- [ ] The build config sets `productName` to `Flujo`, creates a per-user installer, and disables publishing (`--publish never`), so electron-builder never tries to upload anything to GitHub.
- [ ] The build output folder (for example `release/` or `dist/`) is listed in `.gitignore` so installers are never committed.
- [ ] You tested with **synthetic** Bank of America-style statements and CSVs first, not real ones.
- [ ] You have read section L and accepted the known risks.

## F. Build the Installer

The exact script names live in `CLAUDE.md`; the commands below show the usual shape.

1. Install dependencies: `npm install`
2. Run the tests: `npm test`
3. Compile TypeScript and bundle the UI: `npm run build`
4. Package the Windows installer: `npx electron-builder --win nsis --publish never`
5. The installer appears in the output folder as `Flujo Setup <version>.exe`.

**What must be true in the build config** (Claude sets these; the reviewer verifies them):
- `productName` is `Flujo` and the installer is per-user (no elevation required).
- `better-sqlite3` is rebuilt for Electron (electron-builder does this automatically with its dependency install step) and its `.node` files are excluded from the ASAR archive (`asarUnpack`).
- The PDF.js worker file is included and its path resolves inside the packaged app.
- The NSIS installer does **not** delete user data on uninstall (`deleteAppDataOnUninstall: false`).
- Electron security settings from `instructions.md` section 3 are unchanged in the packaged build.
- Application version comes from `package.json`.

## G. Install and First Run

1. Close any dev-mode copy of the app.
2. Run the installer. Windows may show a SmartScreen warning ("Windows protected your PC") because the installer is unsigned. For software you built yourself, choose **More info → Run anyway**. Do not do this for installers from anyone else.
3. Launch Flujo from the Start menu.
4. Complete first-run setup: choose a PIN, a password, or both, and create an account.
5. **Smoke test the installed build** with a synthetic statement before using real data: import a PDF, import a CSV, resolve a duplicate prompt, view the dashboard, run the optimizer, and lock and unlock the app.
6. Only then import real statements.

## H. Data Location, Backups, and Uninstalling

- **Where your data lives:** `%APPDATA%\Flujo\` (the database, retained imports, and logs). To open it, press `Win + R`, type `%APPDATA%`, and press Enter.
- **Backups until in-app backup exists.** In-app backup and restore is in the backlog (section L). Until then, back up manually: **close Flujo completely**, then copy the entire `%APPDATA%\Flujo\` folder to an external drive. Copying while the app is open can produce a corrupted database copy. The automatic backup before migrations does not replace this.
- **Single machine means a single point of failure.** If the disk fails or the folder is deleted, the data is gone. A backup you have never restored is not a backup, so test restoring with synthetic data.
- **Manual backups are not encrypted.** The copied folder contains your financial data in readable form. Keep the external drive somewhere safe.
- **Uninstalling the app does not delete your data** (by design). To remove everything, delete `%APPDATA%\Flujo\` manually after uninstalling.
- **Forgotten PIN or password:** the only recovery is wiping the database (`instructions.md` section 4). Keep a recent backup.

## I. Updating the App

- There is no auto-update. To update, build a new installer (section F) and run it over the existing install.
- The version number must increase for Windows to treat it as an update.
- The app backs up the database automatically before running any migration. Still make a manual backup (section H) before updating.
- Never change the app name (`Flujo`) or app ID during an update.

## J. Things You Can Skip for One Machine

| Skip | Why |
|---|---|
| Code signing certificate | Costs money and effort, and exists to build trust with strangers. Your own build on your own machine does not need it. |
| Auto-update server | You are the only user. |
| Publishing to GitHub Releases or a website | Nothing to distribute, and `workflow.md` forbids pushes without approval. |
| Multi-machine sync | Deferred to the backlog (section L). |
| Microsoft Store packaging | Not needed. |

## K. Troubleshooting

| Symptom | Likely cause | Direction |
|---|---|---|
| Build fails with a compiler or `node-gyp` error | No prebuilt SQLite binary for this Electron version | Install Visual Studio Build Tools (section C), then rebuild |
| Installed app crashes on launch with a "module not found" or "invalid ELF/PE" style error | Native module not rebuilt for Electron, or packed inside ASAR | Verify `asarUnpack` and the rebuild step |
| PDF import works in dev but fails when installed | PDF.js worker file missing or wrong path | Verify the worker is bundled and its path resolves when packaged |
| Blank white window after install | Wrong file path to the UI, or a CSP that blocks the bundled scripts | Check the packaged console output and the CSP |
| Data "disappeared" after update | App name or ID changed, so a new data folder was created | Restore the name `Flujo`, or copy the old data folder |
| SmartScreen blocks the installer | Unsigned installer | More info → Run anyway (own builds only) |
| Dev data appears in the installed app (or vice versa) | Both modes share one data folder | Separate the `userData` paths (section E) |

For any bug, follow the DBG workflow in `workflow.md`: reproduce with Playwright, hand off to the Opus debugger, and have Sonnet implement the fix.

## L. Backlog and Known Risks

**Backlog (not built, not scheduled; Claude must ask before starting any of these):**
1. Multi-machine sync (stretch goal), including encrypted export/import bundles.
2. Disk encryption verification (detecting whether BitLocker / Device Encryption is on) and the first-run notice about it.
3. In-app backup and restore.

**Known risks while these are in the backlog:**
- **Unverified encryption at rest.** The app does not encrypt the database itself, and it does not yet check whether Windows disk encryption is on. If your machine has neither Device Encryption nor BitLocker, anyone with access to the disk can read your data regardless of the PIN or password. The app lock only gates the app's own window.
- **Manual backups only**, and they are unencrypted (section H).

To check encryption yourself at any time: **Settings → Privacy & security → Device encryption** (or **BitLocker** on Windows Pro).
