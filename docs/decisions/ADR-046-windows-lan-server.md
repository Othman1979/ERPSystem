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
- Use Windows Task Scheduler under SYSTEM with highest privileges for the supervised API and Caddy processes and for scheduled jobs. The supervisors append output and restart long-running processes with bounded backoff. No third-party service wrapper is introduced.
- Distribute the Caddy root CA over the LAN only as a trust bootstrap. Each client imports it into its current-user root store after comparing its SHA-256 fingerprint with the server's `INSTALL-INFO.txt`.

## Consequences

- Each client PC must trust the server CA once; Firefox may require separate CA import.
- The server needs a stable LAN address or DHCP reservation, and Windows Firewall permits HTTP/HTTPS only on Private and Domain profiles.
- Caddy is an additional external binary; installation resolves the pinned release and verifies its checksum before use.
- The owner retains a separate development environment, including its own `.env` and `start-local.bat` ports.
- MariaDB installer and service-initialization flags, plus SYSTEM-account behavior, must be confirmed in a real Windows installation before production use.
