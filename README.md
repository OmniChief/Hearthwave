# Hearthwave

**Your entertainment, together.**

Hearthwave is a new, self-hosted home entertainment platform. Instead of opening separate IPTV, Stalker and VOD applications, viewers find films, programmes and channels in one **Library** and one **Live** interface. How those items are supplied belongs in **Settings > Sources**.

This repository is a fresh implementation, not a fork of Vaultcast. The initial milestone targets low-resource ARM64 and x64 NAS devices with one Node.js process and an embedded SQLite database. There is no PHP, Docker, Redis, separate database server or external scheduler in the runtime.

## Current status — series and guide preview (0.3.0)

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
- Xtream Codes server/account connection, Live/VOD/series category discovery and administrator-selected category imports.
- Stalker/MAG portal handshake, registered-device credentials, category discovery and selected Live/VOD/series catalogue imports with deferred stream-link resolution.
- Encrypting provider configuration and stored stream URLs at rest; remote provider requests use bounded response sizes, timeouts, low concurrency and private-network restrictions.
- Retaining folder selections across rediscovery and preserving the last successful source catalogue when an import fails.
- On-demand Xtream episode discovery and bounded, nested Stalker series lookup. Episodes are stored under their parent series, grouped by season, and can be played with source fallback and previous/next navigation.
- Per-channel short provider guide lookup (Xtream and basic Stalker responses), with a five-minute in-memory cache. No scheduled guide fetching on the NAS.

Provider integration is an **early compatibility implementation**, not a fully tested release: portal variants differ, and no live provider account has yet been used for end-to-end verification. Episodes are fetched when a viewer opens a series, rather than during bulk catalogue scans. Some Stalker portals may expose episodes in unsupported forms. No transcoding or guaranteed browser codec support is included.

Designed but **not yet implemented**: complete XMLTV/EPG aggregation, richer artwork metadata retrieval, subtitles, downloads/acquisition, personal scheduled channels, emulation, games, AI generation, community, file sharing, pairing worker PCs, TV compatibility mode, complete installer/updater, backup and migration rollback. Navigation destinations for these capabilities are previews only.

## Run locally

Requires **Node.js 24 or newer** (the initial build uses `node:sqlite` and native TypeScript stripping).

```bash
npm start
```

Open `http://localhost:9999`, create the first administrator, then add sources under Settings. The server listens on port 9999 by default; adjust with `PORT`, `HOST` and `HEARTHWAVE_DATA_DIR`.

```bash
PORT=9090 HOST=127.0.0.1 HEARTHWAVE_DATA_DIR=/path/to/your/data npm start
```

No `npm install` is required to start this preview because it uses Node built-ins. This is a development build, **not yet a hardened installer-ready release**. For access outside your home network, place it behind an authenticated HTTPS reverse proxy and apply appropriate firewall rules. For now, imported M3U playlists are pasted in Settings; a stored reference URL is not automatically fetched.

### Add a provider

1. In **Settings > Sources**, add an **Xtream Codes API** server with its username/password, or a **Stalker / MAG** portal with its registered MAC address (and optional login/device IDs).
2. Click **Discover folders**, then **Refresh status**. If the status reports an error, check your provider address, credentials and device authorisation.
3. Click **Choose folders**, select the desired Live TV, VOD and series categories, and save. No categories are enabled automatically.
4. Click **Scan** to index the selected content. Scan progress is asynchronous; refresh the source status to see completion. Indexed films appear in Library and channels in Live.

Open a series in **Library** to retrieve its episodes on demand. Use **Refresh episodes** if provider contents change. In **Live**, choose **Guide** on an individual channel to load a small number of programme entries from available providers. Provider date/time fields are shown as supplied; a combined timeline and full XMLTV programme database are later work.

Provider requests block localhost and link-local/cloud-metadata destinations. Private RFC1918 or ULA provider addresses require the explicit *Allow a private LAN provider address* checkbox. Use only providers you have permission to access. Browser playback may reveal direct Xtream stream URLs (which contain provider login details) to signed-in viewers; give accounts only to people you trust, and use a dedicated provider account if available.

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
| Xtream | Account authentication, category discovery, selected Live/VOD/series imports; direct playback URLs | Live + Library |
| Stalker portal | Handshake/device profile, category discovery, selected imports and on-demand playback link resolution | Live + Library |
| XMLTV | Not yet implemented | Live guide (planned) |

## Data and upgrade notes

- Data lives in `data/hearthwave.sqlite` unless `HEARTHWAVE_DATA_DIR` is set. `data/` is Git-ignored. Provider URLs, configuration and stored stream commands are encrypted in SQLite; keep `secret.key` from the same directory when backing up. This protects database-only exports, not a completely compromised server.
- The app creates its own schema, runs SQLite in WAL mode, and never requires the user to install MariaDB or Redis.
- Keep the whole data directory together when backing up or moving an installation. Schema v1/v2 databases migrate to v3 on startup. Online database backup, rollback controls and a built-in updater are **next milestones**, not features of this preview.
- Local file streams are served from the configured folder only; symbolic-link escapes are rejected at playback time.
- M3U and direct channels currently use browser-native playback. Some HLS or codec combinations require later compatibility work; the app surfaces an error and tries another available source rather than silently hanging.

## Planned delivery order

1. **Foundation:** shared UI, accounts, content identity and source setup (delivered as the first preview).
2. **Source adapters:** initial Xtream/Stalker connections, selected imports and playback resolution (delivered in v0.2).
3. **Core media:** on-demand provider series episode browsing (this preview); richer local metadata, source preferences, subtitles, requests and downloads remain planned.
4. **Live:** per-channel guide lookup (this preview); broader portal compatibility, improved channel matching, full EPG, radio and personal channels remain planned.
5. **Extended:** games, arcade, creative studio, worker pairing, Community and My Space.
6. **Hardening:** on-device installer/updater, 1 GB RAM profiling, TV/remote controls, security audit, backups and rollback.

The guiding product requirements are captured in the original *Unified Home Entertainment Platform* brief. Hearthwave will develop those requirements iteratively; these previews do not claim to fulfil the entire brief.
