# Isolated IDX template acceptance

Use the repository's pinned Node runtime and installed lockfile dependencies. Unit tests need no database or services:

```powershell
node tests/idx-template/run.mjs --unit
```

Integration uses a separately owned PostgreSQL/PostGIS cluster on **127.0.0.1:54434**, new databases named `estate_acceptance_<16hex>`, and a marker-verified API on a new ephemeral loopback port. The runner refuses the development database, remote URLs and application ports 3000/3001. It initializes only unconfigured synthetic control-role credentials through the reviewed setup script, preserves existing passwords, and drops only its own generated database and file directory afterward. It never stops a PostgreSQL cluster.

The adapter suite proves real RLS, current site/host/policy authority, publication isolation, native CRM notes, tenant/site/listing provenance, routing, concurrent idempotency and rollback. The HTTP suite exercises the actual API controller and native mock provider using signed bridge requests. All records and identities are synthetic; there is no live MLS, messaging, payment, map or browser call.

For a new Windows checkout, obtain approved PostgreSQL binaries with PostGIS support. The example below creates a new cluster inside the current checkout; **do not point it at another cluster's data directory**. Replace the explicit binary directory with the approved installation you intend to use. It does not copy a development configuration, `.env`, database or credentials.

```powershell
$IdxRoot = (Resolve-Path .).Path
$IdxBin = (Resolve-Path 'C:\approved-postgres\bin').Path
$IdxData = [IO.Path]::GetFullPath((Join-Path $IdxRoot '.local\idx-test-pgdata'))
$IdxLocal = [IO.Path]::GetFullPath((Join-Path $IdxRoot '.local'))
$IdxOwner = Join-Path $IdxLocal 'idx-test-postgres-owner.json'
if (-not $IdxData.StartsWith($IdxLocal + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing a data directory outside this checkout.'
}
if (Test-Path -LiteralPath $IdxData) { throw 'A cluster already exists; inspect its ownership instead.' }
if (Test-Path -LiteralPath $IdxOwner) { throw 'Preserve and inspect the existing ownership marker before creating another cluster.' }
if ((Test-Path -LiteralPath $IdxLocal) -and ((Get-Item -LiteralPath $IdxLocal).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Refusing a linked local data directory.'
}
$IdxProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 54434)
try { $IdxProbe.Start() } finally { $IdxProbe.Stop() }
[IO.Directory]::CreateDirectory($IdxLocal) | Out-Null
$IdxPasswordFile = Join-Path $IdxLocal 'idx-test-init-password.txt'
if (Test-Path -LiteralPath $IdxPasswordFile) { throw 'Preserve the existing file and choose another fixture password path.' }
[IO.File]::WriteAllText($IdxPasswordFile, 'idx-migration-only', [Text.UTF8Encoding]::new($false))
try {
  & (Join-Path $IdxBin 'initdb.exe') -D $IdxData -U postgres --auth-local=scram-sha-256 --auth-host=scram-sha-256 -E UTF8 --pwfile=$IdxPasswordFile
  if ($LASTEXITCODE -ne 0) { throw 'Owned cluster initialization failed.' }
} finally {
  Remove-Item -LiteralPath $IdxPasswordFile
}
$IdxLog = Join-Path $IdxLocal 'idx-test-postgres.log'
$IdxControl = Start-Process -FilePath (Join-Path $IdxBin 'pg_ctl.exe') -ArgumentList @(
  '-D', ('"{0}"' -f $IdxData), '-l', ('"{0}"' -f $IdxLog),
  '-o', '"-p 54434 -h 127.0.0.1 -c max_connections=60"', '-w', 'start'
) -WindowStyle Hidden -PassThru
if (-not $IdxControl.WaitForExit(30000) -or $IdxControl.ExitCode -ne 0) {
  throw 'Owned PostgreSQL startup failed; inspect its log before retrying.'
}
$IdxPostmaster = [int](Get-Content -LiteralPath (Join-Path $IdxData 'postmaster.pid') -First 1)
$IdxExecutable = (Get-Process -Id $IdxPostmaster).Path
$IdxExpectedExecutable = (Resolve-Path (Join-Path $IdxBin 'postgres.exe')).Path
if (-not [string]::Equals($IdxExecutable, $IdxExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The started process is not the approved PostgreSQL executable.'
}
if (Test-Path -LiteralPath $IdxOwner) { throw 'Preserve and inspect the existing ownership marker.' }
$IdxMarker = @{
  kind = 'idx-test-postgres'; synthetic = $true; port = 54434; pid = $IdxPostmaster
  worktree = $IdxRoot; dataDirectory = $IdxData; executable = $IdxExpectedExecutable
} | ConvertTo-Json
[IO.File]::WriteAllText($IdxOwner, $IdxMarker, [Text.UTF8Encoding]::new($false))
$env:IDX_TEST_POSTGRES_BINARY = $IdxExpectedExecutable
node tests/idx-template/run.mjs --check
node tests/idx-template/run.mjs
```

`--check` reads the ownership marker, resolves the approved executable and data paths, checks `postmaster.pid`, then queries the actual server's port, data directory, database and PostGIS availability. Integration requires all of these to match the checkout and port. On subsequent shells, set `IDX_TEST_POSTGRES_BINARY` to that same explicitly approved executable (or use the default `<checkout>/.local/postgres/bin/postgres.exe`) and run `--check`. After a deliberate restart of **this owned cluster only**, verify its executable and update the marker's PID from its own `postmaster.pid`; a stale marker fails closed.

Run one integration file or save a JSON result inside this checkout's `.local` directory:

```powershell
$env:ISOLATED_TEST_REPORT = '.local\verification\idx-http.json'
node tests/idx-template/run.mjs tests/idx-template/http.integration.test.ts
```

The bounded regression mode runs the existing native CMS draft/publication suite and the legacy lead/routing capture API suites against new databases on this same verified cluster:

```powershell
node tests/idx-template/run.mjs --regression
```

The runner reserves a second ephemeral loopback origin for `web.integration.test.ts`; that suite starts its own Next process and exercises SSR and the BFF over HTTP. It requires a current successful Next build. It does not use browser automation.

Ubuntu GitHub Actions uses the workflow's separate `idx-postgres` service with `postgis/postgis:17-3.5`, fixture database `postgres`, fixture password `idx-migration-only`, and **127.0.0.1:54434 → container5432**. The job supplies `IDX_TEST_SERVICE_CONTAINER` from `${{ job.services.idx-postgres.id }}`. This path requires `CI=true`, `GITHUB_ACTIONS=true` and Linux; a missing/invalid identity fails closed. It inspects that exact container, image and network through the local Docker Unix socket, requires a healthy running service, the dedicated service alias and private Actions bridge, one anonymous PostgreSQL data volume, and no external binds or user data mounts. It then verifies the actual PostgreSQL data directory, internal port, login identity and PostGIS, and rechecks that the container did not change. These read-only probes never start, stop or alter containers. They never use the application PostgreSQL service on55432. Unit mode remains independent of Docker and PostgreSQL. The network identity matches the [Actions runner's service-container implementation](https://github.com/actions/runner/blob/main/src/Runner.Worker/ContainerOperationProvider.cs).

The CI ownership parser and negative fixtures are verified locally. Actual Ubuntu container acceptance is pending the remote workflow run; Windows native acceptance does not substitute for that result.

This verifies synthetic behavior. Source screenshot comparison, responsive keyboard/accessibility review, live MLS licensing/activation, physical mobile PWA checks and production release acceptance remain separate gates.
