# Hearthwave

**Your entertainment, together.**

Hearthwave is a new, self-hosted home entertainment platform. Instead of opening separate IPTV, Stalker and VOD applications, viewers find films, programmes and channels in one **Library** and one **Live** interface. How those items are supplied belongs in **Settings > Sources**.

This repository is a fresh implementation, not a fork of Vaultcast. The initial milestone targets low-resource ARM64 and x64 NAS devices with one Node.js process and an embedded SQLite database. There is no PHP, Docker, Redis, separate database server or external scheduler in the runtime.

## Current status — Library genre browsing (0.14.0)

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
- Better Live channel identity matching across source names, quality suffixes and regional categories; Live browsing uses country/genre groups instead of provider folders.
- Manual XMLTV and compressed XMLTV.gz imports, saved in a unified SQLite programme database. A new guide is published only after a complete import succeeds; old entries remain visible on failure.
- A combined Live programme grid and per-channel XMLTV guide lookup, with safe matching by guide ID first and normalized name/region second.
- Library detail pages with provider descriptions, genres and ratings when available, artwork covers, and an explicit choice of source/version with client-side playback fallback.
- Administrator-controlled manual XMLTV channel matching within each Live channel's Guide panel, with search and the option to restore automatic matching.
- More reliable film/series grouping: IMDb/TMDB IDs when a provider supplies them, then normalized names and non-conflicting release years. Known different release years remain distinct; one-time database reconciliation preserves favourites, progress and series episode links.
- Adjacent `.vtt` and `.srt` subtitles for local video files, including simple language-suffixed sidecars such as `Film.en.srt`. SRT is converted to WebVTT only when selected, with a 2 MiB file cap and no video conversion.
- Previous/next Live channel controls in the player, following the visible lineup.
- Explicit administrator-triggered provider detail fetch for individual films and series (Xtream VOD/series and best-effort Stalker info), including artwork, description, rating, runtime and external identifiers when offered. The server never fetches these on passive page loads, limits work to three sources, and applies a per-title cooldown.
- Database-backed Library views for all media, favourites and Continue watching; sorting by title, release year, recent additions or recent playback. The Home page now shows recent resume positions.
- Browser-side playback stall detection and automatic fallback after a bounded startup/buffering timeout; the manual source button can cycle back to the first variant. No NAS transcoding or mandatory playback proxy.
- Provider source references are consistently included in backend variant records, repairing the reference used by short provider EPG lookups.
- Stalker category and series pagination now recognizes nested result payloads and advertised totals, with larger but finite catalogue page budgets; incomplete category scans report errors without pruning the last successful generation. Episode discovery understands multiple season-folder and episode-number field forms, within a strict on-demand request budget.
- Collapsible season lists with episode thumbnails where available, individual episode details, playback sources, and watched positions. The most recent season opens by default.
- Per-user, opt-in automatic playback of the next episode, saved in SQLite and available to both administrators and viewers.
- TV-oriented fullscreen button and Up/Down channel changes while the Live player is open; Escape closes playback. Native browser video and remote key handling remain device-dependent.
- A six-hour timeline view for the unified Live XMLTV guide, with day and time-slot navigation (today plus six upcoming days), programme details, current-show highlighting and local-time labels. Channels use provider artwork or matched XMLTV logos, and the guide can page through the lineup 30 channels at a time.
- The guide API now queries only the requested programme window, caps returned programmes per channel, validates the date range and supports paginated channel results without a new scheduler or background service.
- Server-side paging of Library and Live, with reliable result counts, previous/next controls and a direct page jump. Browsing no longer stops at the first 250 titles; search, favourites and sorting apply across all indexed matches.
- Database-backed Live country and genre filters with counts from the entire matching channel catalogue. The Home page requests only six recent Library items and six channels instead of large lists.
- Provider-discovered episodes appear in the Library's explicit Episodes filter without crowding the default film/series view. Opening a title and returning to Library restores the previous page and scroll position.
- Administrator-only source scan progress, showing items received/indexed, current Stalker/Xtream folder and Stalker page. The Sources list updates every few seconds only while a job is active, without replacing the add-source form.
- An explicit **Cancel scan** action for M3U, folder and provider scans. It stops safely after the current bounded request, does not prune the last complete source catalogue, and marks interrupted scans as such after a server restart. Already committed partial new batches may remain visible until the next complete scan.
- **Settings > System** now shows process memory, uptime, database size and schema version. Administrators can download a compressed backup containing a consistent, online SQLite snapshot and the matching encryption key. The archive is streamed from a temporary snapshot without loading the whole database into server memory; the snapshot is cleaned up afterwards.
- Directional **TV remote and keyboard navigation** across Home, Library, Live, guide controls, Settings and the media player. Arrow keys choose the nearest visible control, OK/Enter activates it, and Back/Escape returns from details, guide or player before stepping back through visited pages. The focused control is highlighted and scrolled into view; focus is recovered after list refreshes.
- Native text entry and selection controls keep their normal keyboard behavior. While a Live channel is playing, Up/Down still changes channels; television-specific remote key codes used by Samsung/Tizen and LG/WebOS Back buttons are recognized when delivered as keyboard events. Actual remote/browser key mappings still depend on the device.
- **Unified Library genres:** Films and series can be filtered by Action, Comedy, Drama, Sci-Fi and other familiar genres across all connected providers. Mixed-genre titles appear in each applicable genre without duplicate cards. The genre rail shows whole-catalogue counts for the selected media type, search and Favourites/Continue watching view, independently of pagination.
- Provider genre labels are normalized into a fixed list; when a film or series lacks metadata, recognizable provider-folder genres can populate the filter. Unclassified items stay under Other. A small indexed SQLite genre table supports browsing without scanning provider JSON or loading the full catalogue into browser memory.

Provider integration is an **early compatibility implementation**, not a fully tested release: portal variants differ, and no live provider account has yet been used for end-to-end verification. Episodes are fetched when a viewer opens a series, rather than during bulk catalogue scans. Some Stalker portals may expose episodes in unsupported forms. No transcoding or guaranteed browser codec support is included.

Designed but **not yet implemented**: automatically refreshed XMLTV schedules, external artwork/metadata enrichment beyond what providers supply, remote-provider subtitle discovery, downloads/acquisition, personal scheduled channels, emulation, games, AI generation, community, file sharing, pairing worker PCs, complete installer/updater, guided backup restore and migration rollback. Directional controls now work at the browser level, but native remote mapping and television playback still need device validation. Navigation destinations for unbuilt capabilities are previews only.

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
4. Click **Scan** to index the selected content. Scan progress is asynchronous and updates automatically while the Sources panel is open. Indexed films appear in Library and channels in Live.

While a scan is running, the Sources panel displays live counts and the active provider folder/page where applicable. Use **Cancel scan** to stop a run. It takes effect after the current provider request finishes (normally within its request timeout), and previously indexed content is not removed. A later successful scan reconciles any partial new batches.

Open a series in **Library** to retrieve its episodes on demand. Use **Refresh episodes** if provider contents change. In **Live**, choose **Guide** on a channel for programme details or **Programme guide** for the combined XMLTV lineup. The combined guide has four six-hour time slots, next-day navigation and **More channels** paging; select a programme block for its description.

Season sections expand or collapse independently. Open an episode's **Details** to inspect its sources; use the checkbox above the seasons to save your personal **Automatically play the next episode** preference. In the player, use **Fullscreen** for a TV display. While watching Live TV, the Up/Down keys change channels where the TV remote sends normal keyboard arrows.

### TV remote and keyboard controls

- **Arrow keys:** move focus between visible actions, cards, navigation tabs and guide controls. The currently focused action has a prominent peach outline; the view scrolls as needed.
- **OK / Enter:** select the focused action. Native form fields and the video player retain their usual controls; use Left/Right within editable text without moving focus.
- **Back / Escape:** leave a player, close an open channel guide, return from an item/series detail, then return to the previously visited section. Press Escape while editing to leave the field. Backspace is Back only outside editable fields.
- **While watching Live:** Up/Down switches between channels in the current visible lineup; choose the on-screen channel buttons for the same action.

This runs in the existing browser client without installing a television SDK, browser extension or extra server process. Samsung Tizen, LG WebOS and remote-control browsers differ in which hardware buttons they expose to websites, so physical remote compatibility still needs real-device testing.

Choose **Details** on a Library item to view available metadata and select an individual source. Where one provider offers no artwork or description, Hearthwave uses what another source supplied for the shared title; it does not make an external lookup.

Administrators can choose **Fetch provider details** on a film or series page to request richer information directly from up to three of its configured providers. This is manual and rate-limited to once per title per minute, with no automatic NAS metadata scraper. Not every Stalker portal supports the same detail endpoint.

Use **Favourites** or **Continue watching** in Library to see matching media across the full database. The sort menu offers title, release year, newest indexed titles and most recent playback.

The **Library genre rail** narrows films and series to genres such as Action, Comedy and Sci-Fi. Counts include all matching titles, not just the current page, and follow search and favourite/resume filters. A title tagged Action and Thriller appears in both genres but remains a single Library tile. Select **All genres** to clear the genre filter. Music, photos and the explicit Episodes view remain available through the media-type buttons; those views do not use the film/series genre rail.

Library and Live display the matching total and let you move forward/backward or jump directly to a page number. Live genre counts are calculated across the selected region, not merely the channels visible on the current page. The app never loads the full provider catalogue into browser memory just to filter it.

For local files, place `.vtt` or `.srt` subtitles next to the video with the same basename, optionally adding a language code (`Movie.en.srt`, `Movie.fr.vtt`). The player shows a subtitle selector when it finds a supported file. Only subtitles are converted on demand; the video is never transcoded. In Live, the player also has previous/next channel controls for the current lineup.

### Add a unified TV guide

1. In **Settings > Metadata & Guide**, choose **Use UK example** or **Use US example**, or enter a public XMLTV URL. The examples come from [Open-EPG](https://www.open-epg.com/app/epgguide.php).
2. Add the feed, then click **Import**. XMLTV and `.xml.gz` files are streamed and parsed in bounded chunks; the app does not require a separate scheduler or persistent background worker.
3. In **Live**, open **Programme guide** to see channel programmes, or use the per-channel Guide button. Existing guide entries stay available if a later import fails.
4. If a channel has no matching programme data, open its **Guide** panel and choose **Match an XMLTV channel** (administrator only). Search the imported channel names/IDs and save a match. You can later return to automatic matching; a manual match persists through feed refreshes when the XMLTV channel ID stays the same.

Open-EPG updates its free files about once daily and asks clients to avoid excessive downloads; Hearthwave limits successful refreshes of each Open-EPG feed to at least six hours apart. Guide URLs must be public HTTP(S) endpoints. A combined XMLTV entry uses explicit guide IDs where possible; name matching is conservative when different countries have similarly named channels.

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
| XMLTV | Manual URL import, `.xml.gz` streaming, matching and aggregated guide display | Live guide |

## Data and upgrade notes

- Data lives in `data/hearthwave.sqlite` unless `HEARTHWAVE_DATA_DIR` is set. `data/` is Git-ignored. Provider URLs, configuration and stored stream commands are encrypted in SQLite; keep `secret.key` from the same directory when backing up. This protects database-only exports, not a completely compromised server.
- The app creates its own schema, runs SQLite in WAL mode, and never requires the user to install MariaDB or Redis.
- In **Settings > System**, administrators can download a `.tar.gz` backup with `manifest.json`, `hearthwave.sqlite` (a WAL-consistent online snapshot) and `secret.key`. Only one backup runs at a time, CSRF protection is required, and the NAS needs free disk space for a temporary database snapshot. The archive contains sensitive account data and, with the included key, decryptable provider credentials: store and transfer it securely. External media folders, local video files and media paths referenced by catalogue entries are **not** included.
- To restore to a **new data directory**, stop Hearthwave or use a different port, then extract the archive to an empty directory and point `HEARTHWAVE_DATA_DIR` at it. For example:

  ```bash
  mkdir -p /path/to/restored-data
  tar -xzf hearthwave-backup-YYYYMMDDHHMM.tar.gz -C /path/to/restored-data
  HEARTHWAVE_DATA_DIR=/path/to/restored-data PORT=9998 npm start
  ```

  Check the restored account and catalogue before switching traffic. Do **not** extract over a running installation or replace a live SQLite/WAL file. The download is not a substitute for preserving your actual media and any other external files.
- Older databases migrate to schema v9 on startup. The v9 migration indexes Library genres in bounded batches without external metadata lookups; v8 indexes Live genre classification, and v7 stores user playback preferences. The earlier v6 upgrade conservatively merges duplicate film/series titles (preserving personal data and episode links) only where the known release years do not conflict. Guided restore, migration rollback and a built-in updater are **future milestones**.
- Local file streams are served from the configured folder only; symbolic-link escapes are rejected at playback time.
- M3U and direct channels currently use browser-native playback. The browser tries another available source after a playback error or sustained stall, but this cannot make an unsupported HLS/codec combination play on an incompatible device. The app never transcodes the stream on the NAS.

## Planned delivery order

1. **Foundation:** shared UI, accounts, content identity and source setup (delivered as the first preview).
2. **Source adapters:** initial Xtream/Stalker connections, selected imports and playback resolution (delivered in v0.2).
3. **Core media:** on-demand provider series episode browsing (v0.3), Library details and explicit source choice (v0.5), identity matching and local sidecar subtitles (v0.6), manual provider metadata refresh and saved Library views (v0.7), season accordions and next-episode controls (v0.8), full-catalogue paging (v0.10), multi-source genre browsing (v0.14); external metadata services, remote subtitles, requests and downloads remain planned.
4. **Live:** provider guide lookup (v0.3), normalized channel matching and manual unified XMLTV (v0.4), manual channel mapping (v0.5), a paginated multi-day guide timeline (v0.9), server-indexed region/genre filters (v0.10); automated guide refresh, broader portal compatibility, radio and personal channels remain planned.
5. **Extended:** games, arcade, creative studio, worker pairing, Community and My Space.
6. **Hardening:** administrator backup export and basic process metrics (v0.12), directional keyboard/TV-remote navigation (v0.13); on-device installer/updater, 1 GB RAM profiling, real-device remote compatibility, security audit, guided restore and rollback remain planned.

The guiding product requirements are captured in the original *Unified Home Entertainment Platform* brief. Hearthwave will develop those requirements iteratively; these previews do not claim to fulfil the entire brief.
