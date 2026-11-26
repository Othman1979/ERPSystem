# ADR-046: Windows LAN server

**Status:** Accepted
**Date:** 2026-11-23

## Context

The owner needs a Windows PC to host ERP Cloud for employees on the local network, while keeping a separate development checkout on that PC. Production mode requires an HTTPS origin: it rejects localhost or non-HTTPS `CORS_ORIGIN`, marks refresh cookies secure, and enables Helmet's insecure-request upgrade policy. The API serves the built web app when `WEB_DIST_DIR` is configured, so browser traffic can remain same-origin.

## Decision

- Install the production server in a dedicated clone, separate from the owner's development checkout.
- Use `TENANCY_MODE=shared` and a dedicated MariaDB 11.8 service and data directory. The database listens on loopback and is not exposed to the LAN.
- Put Caddy in front of the API. Pin Caddy to v2.11.9, verify its published SHA-512 checksum, place it under `<DataDir>\bin`, use `tls internal`, and keep its CA storage under the installation data directory.
- Set `TRUST_PROXY=loopback`; Caddy and the API communicate over loopback.
- Run the API (`ERP-App`) and HTTPS proxy (`ERP-Caddy`) as automatic LocalSystem Windows services. The API depends on `ERP-MariaDB`. Each service uses WinSW v2.12.0, the self-contained x64 build recommended by Caddy's service documentation, with matching `<DataDir>\services\<id>\<id>.exe` and `<id>.xml`. Both services use three restart actions at 10-second intervals, a one-hour failure reset period, and a 15-second stop timeout. WinSW rolls stdout and stderr by size at 10 MB, retaining five rotated files per stream.
- Pin the exact [WinSW v2.12.0 release artifact](https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe) to 18,243,033 bytes and self-pin its SHA-256 to `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`; upstream does not publish a checksum. WinSW v2.12.0 has no `refresh` command. On an existing service, setup stops it, rewrites the XML, reapplies the executable path, display name, automatic start, LocalSystem account, dependencies, and failure policy in place via `sc.exe`, then starts it.
- Keep Cron-style `Job-*` tasks in Windows Task Scheduler under SYSTEM with highest privileges. Setup migrates just the former API and Caddy tasks to services.
- Distribute the Caddy root CA over the LAN only as a trust bootstrap. Each client imports it into its current-user root store after comparing its SHA-256 fingerprint with the server's `INSTALL-INFO.txt`.

## Consequences

- Each client PC must trust the server CA once; Firefox may require separate CA import.
- The server needs a stable LAN address or DHCP reservation, and Windows Firewall permits HTTP/HTTPS only on Private and Domain profiles.
- Caddy and WinSW are external binaries; installation verifies their pinned releases before use.
- The owner retains a separate development environment, including its own `.env` and `start-local.bat` ports.
- MariaDB installer and service-initialization flags, plus SYSTEM-account behavior, must be confirmed in a real Windows installation before production use.
