# navidrome-slop-sync

A small mobile web player for listening to Navidrome together. Sign into the same account on both devices. Search for a song, tap it to play, or tap + to queue it. Use “Play album” to replace the queue with an album in track order, or “Queue album” to append the whole album. Playback, pause, seeking and next are shared. Tap “Enable audio on this device” when joining.

I needed a temporary way to listen to Navidrome together, so I had Codex build this. It does what I needed; maybe someone else finds it useful too.

Build-session token snapshot: 7,077,126 total, including 6,891,136 cached input tokens, 151,518 uncached input tokens, and 34,472 output tokens. These are local Codex session counts, including setup, testing, deployment, and repository work, not a billing estimate.

## Local

```sh
bun install
mise run build
NAVIDROME_URL=http://localhost:4533 mise run start
```

Open http://localhost:3000. `PORT` defaults to 3000. Plain TypeScript, native HTML controls and a Bun server. No runtime dependencies or database. Original audio streams directly from Navidrome, including byte ranges for seeking.

Sessions and playback state reset on restart. Navidrome authentication tokens stay in server memory. Browsers receive an HttpOnly session cookie. Use HTTPS outside a trusted LAN.

Keep both browser tabs open. Synchronization polls once per second and corrects drift over 1.2 seconds. Background tabs and locked phones can be suspended by mobile browsers.

```sh
mise run check
mise run build
```
