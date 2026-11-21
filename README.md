# Hearthwave

**Your entertainment, together.**

Hearthwave is a new, self-hosted home entertainment platform. Instead of opening separate IPTV, Stalker and VOD applications, viewers find films, programmes and channels in one **Library** and one **Live** interface. How those items are supplied belongs in **Settings > Sources**.

This repository is a fresh implementation, not a fork of Vaultcast. The initial milestone targets low-resource ARM64 and x64 NAS devices with one Node.js process and an embedded SQLite database. There is no PHP, Docker, Redis, separate database server or external scheduler in the runtime.

## Current status — foundation preview (0.1.0)

Working now:

- Responsive, installable web-app shell with navigation for Home, Library, Live, Play, Create, Community, My Space and Settings.
- Local administrator setup, password-protected sessions, CSRF protection, viewer accounts and administrator-only source management.
- SQLite data model for canonical media identities, source variants, user favourites and resume positions.
- Local media folder scanning (films, numbered series episodes, music, pictures), bounded to 50,000 entries and nine nested levels.
- Pasted M3U playlist imports, up to 25,000 channel records, progressively written in batches of 128.
- Direct HTTP(S) live channel sources.
- Grouped channel variants by guide identifier or normalized title, with source selection and client-side fallback on playback error.
- Authenticated byte-range streaming of local media without live transcoding.
- Basic Library/Live search and source status.

Designed but **not yet implemented**: Xtream and Stalker provider communication, remote VOD, XMLTV/EPG merging, artwork metadata retrieval, subtitles, downloads/acquisition, personal scheduled channels, emulation, games, AI generation, community, file sharing, pairing worker PCs, TV compatibility mode, complete installer/updater, backup and migration rollback. Navigation destinations for these capabilities are previews only.

## Run locally

Requires **Node.js 24 or newer** (the initial build uses `node:sqlite` and native TypeScript stripping).

```bash
npm start
```

Open `http://localhost:9999`, create the first administrator, then add sources under Settings. The server listens on port 9999 by default; adjust with `PORT`, `HOST` and `HEARTHWAVE_DATA_DIR`.

```bash
PORT=9090 HOST=127.0.0.1 HEARTHWAVE_DATA_DIR=/path/to/your/data npm start
```

No `npm install` is required to start the foundation because it uses Node built-ins. This is a development foundation, **not yet a hardened installer-ready release**. For access outside your home network, place it behind an authenticated HTTPS reverse proxy and apply appropriate firewall rules. For now, imported M3U playlists are pasted in Settings; a stored reference URL is not automatically fetched.

## Design principles

1. **User intent first.** Films and shows appear in Library; channels and radio belong in Live. No everyday Stalker or IPTV navigation.
2. **One item, many sources.** A normalized title or channel identity owns many variants; removing a connection does not require deleting another source's data.
3. **Small server, optional big workers.** Discovery is bounded and incremental. Expensive AI work and conversion will eventually be delegated to optional paired PCs.
4. **Explicit control.** Background imports are only started on administrator action. Credentials, scanning, provider folder choices and diagnostics remain in Settings.
5. **Modular monolith.** One Node process coordinates feature modules and SQLite WAL; no mandatory container platform, cron, message broker or external DB.

## Source support

| Source | Foundation support | Content destination |
| --- | --- | --- |
| Local folder | Manual incremental scan; authenticated range playback | Library |
| M3U | Import pasted playlist; direct-play channels | Live |
| Direct HTTP(S) stream | Add one channel immediately | Live |
| Xtream | Placeholder only; no provider requests yet | Live + Library (planned) |
| Stalker portal | Placeholder only; no provider requests yet | Live + Library (planned) |
| XMLTV | Not yet implemented | Live guide (planned) |

## Data and upgrade notes

- Data lives in `data/hearthwave.sqlite` unless `HEARTHWAVE_DATA_DIR` is set. `data/` is Git-ignored. Provider URLs are encrypted in SQLite; keep `secret.key` from the same directory when backing up. This protects database-only exports, not a completely compromised server.
- The app creates its own schema, runs SQLite in WAL mode, and never requires the user to install MariaDB or Redis.
- Keep the whole data directory together when backing up or moving an installation. Online database backup, schema migrations beyond v1 and a built-in updater are **next milestones**, not features of this preview.
- Local file streams are served from the configured folder only; symbolic-link escapes are rejected at playback time.
- M3U and direct channels currently use browser-native playback. Some HLS or codec combinations require later compatibility work; the app surfaces an error and tries another available source rather than silently hanging.

## Planned delivery order

1. **Foundation:** shared UI, accounts, content identity, source setup and adapter boundaries (this preview).
2. **Core media:** provider VOD, local metadata, source preferences, subtitles, requests and downloads.
3. **Live:** full IPTV/Xtream/Stalker adapters, unified channel matching, EPG, radio and personal channels.
4. **Extended:** games, arcade, creative studio, worker pairing, Community and My Space.
5. **Hardening:** on-device installer/updater, 1 GB RAM profiling, TV/remote controls, security audit, backups and rollback.

The guiding product requirements are captured in the original *Unified Home Entertainment Platform* brief. Hearthwave will develop those requirements iteratively; this first commit does not claim to fulfil the entire brief.
