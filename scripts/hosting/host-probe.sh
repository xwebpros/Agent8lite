#!/bin/bash
# Fixed read-only inventory. No login shell, sudo, installation or service changes.
ae_marker='AEHOST1:__NONCE__'
ae_emit() { printf '%s:%s:%s\n' "$ae_marker" "$1" "$2"; }
ae_flag() {
  if command -v "$2" >/dev/null 2>&1; then ae_emit "$1" 1; else ae_emit "$1" 0; fi
}
ae_token() {
  if [[ "$3" =~ $2 ]]; then ae_emit "$1" "$3"; else ae_emit "$1" -; fi
}
printf '%s:BEGIN\n' "$ae_marker"
ae_token kernel '^[A-Za-z_][A-Za-z0-9_]{0,23}$' "$(uname -s 2>/dev/null)"
ae_token arch '^[A-Za-z_][A-Za-z0-9_]{0,23}$' "$(uname -m 2>/dev/null)"
ae_token os_id '^[a-z][a-z0-9_]{0,31}$' "$(awk -F= '$1 == "ID" {gsub(/"/, "", $2); print $2; exit}' /etc/os-release 2>/dev/null)"
ae_token os_version '^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$' "$(awk -F= '$1 == "VERSION_ID" {gsub(/"/, "", $2); print $2; exit}' /etc/os-release 2>/dev/null)"
ae_token cpanel_version '^[0-9]{1,3}(\.[0-9]{1,5}){1,3}$' "$(awk 'NR == 1 {sub(/^11\./, ""); print; exit}' /usr/local/cpanel/version 2>/dev/null)"
ae_node="$(env -u NODE_OPTIONS -u NODE_PATH node --version 2>/dev/null)"
ae_token node_version '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' "${ae_node#v}"
ae_flag pnpm_present pnpm
# Read installed pnpm package metadata; never invoke pnpm/Corepack or download it.
ae_pnpm_path="$(command -v pnpm 2>/dev/null)"
ae_pnpm_version=-
if [[ -n "$ae_pnpm_path" && "$ae_node" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ae_pnpm_version="$(env -u NODE_OPTIONS -u NODE_PATH node -e '
    const fs = require("node:fs"), path = require("node:path");
    let version = "-";
    try {
      let dir = path.dirname(fs.realpathSync(process.argv[1]));
      for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
        const file = path.join(dir, "package.json");
        if (!fs.existsSync(file) || fs.statSync(file).size > 65536) continue;
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        if (pkg.name === "pnpm" && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(pkg.version)) {
          version = pkg.version; break;
        }
      }
    } catch {}
    process.stdout.write(version);
  ' "$ae_pnpm_path" 2>/dev/null)"
fi
ae_token pnpm_version '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' "$ae_pnpm_version"
ae_token psql_client_version '^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$' "$(psql --version 2>/dev/null | sed -n 's/^psql (PostgreSQL) \([0-9.]*\).*$/\1/p')"
ae_token redis_binary_version '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' "$(redis-server --version 2>/dev/null | sed -n 's/^Redis server v=\([0-9.]*\) .*$/\1/p')"
ae_token cpu_count '^[0-9]{1,4}$' "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"
ae_token memory_kib '^[0-9]{1,12}$' "$(awk '$1 == "MemTotal:" {print $2; exit}' /proc/meminfo 2>/dev/null)"
ae_token disk_free_kib '^[0-9]{1,12}$' "$(LC_ALL=C df -Pk / 2>/dev/null | awk 'NR == 2 {print $4; exit}')"
ae_uid="$(id -u 2>/dev/null)"
if [[ "$ae_uid" == 0 ]]; then ae_emit account_class root
elif [[ "$ae_uid" =~ ^[0-9]+$ ]]; then ae_emit account_class unprivileged
else ae_emit account_class -; fi
ae_flag systemd_present systemctl
ae_flag supervisor_present supervisord
ae_flag passenger_present passenger
ae_flag nginx_present nginx
ae_flag httpd_present httpd
ae_emit database_roles_verified 0
ae_emit postgis_verified 0
ae_emit worker_supervision_verified 0
ae_emit private_storage_verified 0
ae_emit https_origin_verified 0
ae_emit restore_verified 0
printf '%s:END\n' "$ae_marker"
