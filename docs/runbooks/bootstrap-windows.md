# Windows click-to-run setup

For a clean Agent8lite source ZIP on a **Docker-supported 64-bit Intel/AMD Windows 10/11 computer**, extract the entire ZIP to a normal writable folder, then double-click **`Start-Agent8lite.cmd`** in the project root. Do not run it inside the ZIP viewer. Internet access is required for the first setup. Extraction uses Windows' built-in `tar.exe` to support Node/npm's nested paths.

The launcher downloads the repository-pinned Node.js **24.19.0**, checks its archive against both the publisher's checksum and the reviewed SHA-256, and installs pnpm **11.25.0** under `.local/bootstrap/`. It does not replace global Node/pnpm or permanently change PATH or PowerShell policy.

If Docker Desktop is missing, setup opens its installer through WinGet. Without WinGet, it downloads the official installer and requires a valid Windows Authenticode signature before executing it. Docker's agreement/installer, Windows administrator approval and WSL/virtualization setup may need the recipient's interaction. The script does not silently accept Docker's terms, disable security checks, automatically restart Windows or register an autorun task. If a restart is needed, restart when convenient and click the same launcher again. Docker Desktop's supported Windows/WSL/hardware and license requirements still apply.

Once a local Linux Docker engine is ready, setup:

1. Verifies application ports 3000/3001 and database ports 55432/56379 are available or belong to this folder's database containers.
2. Runs the frozen-lockfile dependency install with the portable tools.
3. Starts the included PostgreSQL/PostGIS and Redis services under a stable, folder-specific Compose project.
4. Runs forward migrations, separate synthetic control/issuer identity configuration and fictional-data seed using the existing repository scripts.
5. Starts the loopback API and web servers with an explicit synthetic environment, mock MLS and no-delivery transport.
6. Waits for the owned API instance marker, owned Next readiness and a successful web response, then opens **http://localhost:3000**.

Use the app's fictional Owner or Agent sign-in. Keep the setup window open while using the app. **Ctrl+C or closing that window stops its owned application process tree.** Ordinary setup subprocesses also use a private Windows Job Object so timeouts stop their own descendants. Windows may launch elevated system installers through its separate UAC broker; complete/cancel those visible installers using their own interface before retrying. Docker/database containers remain running and their local records persist. No background campaign worker, live provider or production service is activated by this launcher.

Clicking again while setup is running reports the existing setup. Clicking again while that verified bootstrap app is healthy opens the browser. The bootstrapper never kills an unrelated process from a PID file. On later starts, it rechecks dependencies, Docker, migrations and seed rather than trusting a phase marker. Existing records, role passwords, applied migration checksums and revocations are preserved by the underlying reviewed scripts; a mismatch is an error, not permission to reset data.

## Scope and local storage

- `.local/bootstrap/tools/`: portable Node and pnpm.
- `.local/bootstrap/downloads/`: verified download cache.
- `.local/bootstrap/pnpm-store/`: package cache.
- `.local/bootstrap/setup-state.json`: diagnostic phase checkpoint, not acceptance evidence or authority to skip checks.
- `.local/bootstrap/running.json`: current runtime identity. It is checked against executable, process creation time and API instance before reuse; it is never authority to terminate an old process.
- Docker volumes: persist database records under `agent8lite-<folder-hash>`. Moving the source folder changes this identity and therefore selects a different database project. Keep the folder location stable to retain the same sample records.
- `.local/private-objects/`: synthetic private uploads created by the app.

Setup uses the existing public local fixture passwords and does not read private `.env` files. A clean package containing private environment files in the root or `apps/web` is refused. Inherited hosted/production settings, provider credentials, remote database/Redis/Docker settings and `NODE_OPTIONS` are excluded. Ordinary OS, proxy and CA settings needed to download packages are retained. All database URLs are fixed to loopback and application, worker, control, issuer and migration identities remain distinct.

## Troubleshooting

| Message/state | Action |
| --- | --- |
| Docker/WSL needs attention | Complete Docker's visible setup, enable supported WSL/virtualization when prompted and restart if requested. Click again after Docker is ready. Use the official Docker guide; don't run the entire application as administrator. |
| Port 3000/3001 occupied | Close the existing app in its own terminal, or use another computer. The launcher preserves that process. |
| Database port 55432/56379 belongs to another installation | Stop that installation using its own tools. Never delete its database or change its passwords to accommodate this setup. |
| Private environment files present | Create a source-only package without those files. Do not copy production/provider credentials to a recipient. |
| Download interrupted/checksum failed | Click again to retry an incomplete download. If the completed cached archive fails validation, remove only that named bootstrap archive after inspecting it and retry. No unverified archive is executed. |
| Node extraction incomplete | Move the specifically owned `.local/bootstrap/tools` folder aside and retry. Do not touch `.local/pgdata`, uploads or Docker volumes. |
| Runtime pins changed | The integration owner must review/update bootstrap download hashes and compatibility alongside the runtime/lockfile change. Setup refuses a silent upgrade. |
| WinGet/installer cancelled | Run the launcher again and complete the visible installer, or install Docker Desktop from the official guide. |
| Frozen install or migration fails | Read the operation/exit code and visible output, resolve the underlying failure and retry. Do not bypass the lockfile, rewrite applied migrations or reset the database. |
| Browser does not open | Read the startup window; no ready claim is made until both owned servers are ready. After success, open http://localhost:3000 manually if the default-browser association is unavailable. |
| Company policy blocks scripts/downloads/Docker | Ask the recipient's IT administrator to approve the required software/source. Process-scoped ExecutionPolicy cannot override enforced organizational policy. |

For macOS, Linux, Windows ARM or a manual setup, use `docs/runbooks/local-development.md`. This Windows launcher is not a production installer or deployment mechanism.

## Sharing the source package

Include the root launcher, all `scripts/bootstrap/` files, application/package source, migrations, `compose.yaml`, lockfile/workspace/root configuration and `.env.example`. Exclude `node_modules`, `.local`, `.git`, `.pnpm-store`, build/test outputs, private environment files, credentials, agreements and raw audit/customer/MLS exports. The launcher creates new fictional sample data; it does not transfer the sender's current database.

## Verification

Run without installing or starting anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap/windows.ps1 -CheckOnly
```

This reports the required pins, folder-specific project and occupied ports; `actionsPerformed` is empty. Pure PowerShell helpers are available to the test harness with `-LibraryOnly`.

With the approved Node and installed development dependencies:

```powershell
node node_modules/vitest/vitest.mjs run --config scripts/bootstrap/vitest.config.mts
node --check scripts/bootstrap/runtime.mjs
pnpm exec biome check scripts/bootstrap
```

On 2026-10-13, **77/77 tests passed**, including native Windows quoting, real Job Object descendant cleanup that preserved an unrelated test process, and real tar extraction of a fixture with paths longer than260 characters. Tests use fake processes/network/ports or owned helper processes/files; they do not install Docker, download software, migrate a database or stop current services. A separate bounded smoke verified actual official Node download/archive/executable hashes and project-local pnpm installation without Docker/global PATH/service changes. Actual first Docker installation, UAC/WSL restart, image pulls and a clean-machine end-to-end run remain separate unexecuted acceptance cases.

Official sources: [Docker Desktop Windows setup](https://docs.docker.com/desktop/setup/install/windows-install/), [WinGet install options](https://learn.microsoft.com/en-us/windows/package-manager/winget/install), [pnpm installation](https://pnpm.io/installation), [pinned Node publisher checksums](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt). The Node archive SHA-256 used here is `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`.
