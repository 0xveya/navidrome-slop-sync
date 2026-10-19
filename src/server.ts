import { createHash, randomBytes } from 'node:crypto';
import type { Album, Playback, RoomState, Song } from './shared';

const upstream = (process.env.NAVIDROME_URL ?? 'http://localhost:4533').replace(/\/$/, '');
const sessions = new Map<string, Session>();
const rooms = new Map<string, Playback>();
const attempts = new Map<string, { count: number; until: number }>();
const lifetime = 7 * 24 * 60 * 60 * 1000;
interface Session { username: string; token: string; salt: string; expires: number; seen: number }
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid request.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new HttpError(400, 'Missing or invalid value.');
  return value;
}
function urlFor(session: Session, method: string, params: Record<string, string> = {}): URL {
  const url = new URL(`${upstream}/rest/${method}`);
  url.search = new URLSearchParams({ u: session.username, t: session.token, s: session.salt, v: '1.16.1', c: 'navidrome-slop-sync', f: 'json', ...params }).toString();
  return url;
}
async function subsonic(session: Session, method: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(urlFor(session, method, params), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(502, 'Navidrome could not be reached.');
  const data = object(object(await response.json())['subsonic-response']);
  if (data.status !== 'ok') {
    const error = object(data.error);
    throw new HttpError(error.code === 40 ? 401 : 502, typeof error.message === 'string' ? error.message : 'Navidrome rejected the request.');
  }
  return data;
}
function song(value: unknown): Song {
  const data = object(value);
  return { id: text(data.id), title: text(data.title), artist: typeof data.artist === 'string' ? data.artist : 'Unknown artist', album: typeof data.album === 'string' ? data.album : '', duration: typeof data.duration === 'number' ? data.duration : 0, coverArt: typeof data.coverArt === 'string' ? data.coverArt : undefined };
}
function album(value: unknown): Album {
  const data = object(value);
  return { id: text(data.id), name: text(data.name), artist: typeof data.artist === 'string' ? data.artist : 'Unknown artist', songCount: typeof data.songCount === 'number' ? data.songCount : 0 };
}
function room(username: string): Playback {
  let value = rooms.get(username);
  if (!value) {
    value = { queue: [], index: 0, playing: false, position: 0, updatedAt: Date.now(), revision: 0 };
    rooms.set(username, value);
  }
  return value;
}
function position(state: Playback): number {
  return Math.min(state.queue[state.index]?.duration ?? 0, state.position + (state.playing ? (Date.now() - state.updatedAt) / 1000 : 0));
}
function state(session: Session): RoomState {
  return { ...room(session.username), username: session.username, serverTime: Date.now(), listeners: [...sessions.values()].filter(s => s.username === session.username && s.seen > Date.now() - 15000).length };
}
function cookie(req: Request): string | undefined {
  return req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('navidrome-slop-sync='))?.slice('navidrome-slop-sync='.length);
}
function cookieHeader(req: Request, value: string, age: number): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `navidrome-slop-sync=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
}
const server = Bun.serve({
  maxRequestBodySize: 16384, hostname: '0.0.0.0', port: Number(process.env.PORT ?? 3000),
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      if (req.method === 'POST') {
        const origin = req.headers.get('origin');
        if (origin && new URL(origin).host !== req.headers.get('host')) throw new HttpError(403, 'Invalid origin.');
        if (!req.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
        if (Number(req.headers.get('content-length') ?? 0) > 16384) throw new HttpError(413, 'Request too large.');
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = server.requestIP(req)?.address ?? 'unknown';
        const rate = attempts.get(ip);
        if (rate && rate.until > Date.now() && rate.count >= 15) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
        attempts.set(ip, { count: rate && rate.until > Date.now() ? rate.count + 1 : 1, until: Date.now() + 60000 });
        const body = object(await req.json());
        const username = text(body.username, 100).trim();
        const password = text(body.password, 1024);
        const salt = randomBytes(16).toString('hex');
        const session: Session = { username, salt, token: createHash('md5').update(password + salt).digest('hex'), expires: Date.now() + lifetime, seen: Date.now() };
        await subsonic(session, 'ping');
        // Use Navidrome's canonical username so account casing cannot split a room.
        const user = object((await subsonic(session, 'getUser', { username })).user);
        session.username = text(user.username, 100);
        const id = randomBytes(32).toString('hex');
        const old = cookie(req);
        if (old) sessions.delete(old);
        sessions.set(id, session);
        attempts.delete(ip);
        return Response.json(state(session), { headers: { 'Set-Cookie': cookieHeader(req, id, lifetime / 1000), 'Cache-Control': 'no-store' } });
      }
      if (url.pathname.startsWith('/api/')) {
        const id = cookie(req);
        const session = id ? sessions.get(id) : undefined;
        if (!session || session.expires < Date.now()) throw new HttpError(401, 'Sign in to your Navidrome account.');
        session.seen = Date.now();
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          sessions.delete(id!);
          return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader(req, '', 0) } });
        }
        if (url.pathname === '/api/state' && req.method === 'GET') return Response.json(state(session), { headers: { 'Cache-Control': 'no-store' } });
        if (url.pathname === '/api/songs' && req.method === 'GET') {
          const query = url.searchParams.get('q')?.slice(0, 200).trim();
          const data = query ? await subsonic(session, 'search3', { query, songCount: '40', albumCount: '0', artistCount: '0' }) : await subsonic(session, 'getRandomSongs', { size: '30' });
          const results = object(data[query ? 'searchResult3' : 'randomSongs']).song;
          return Response.json(Array.isArray(results) ? results.map(song) : []);
        }
        if (url.pathname === '/api/albums' && req.method === 'GET') {
          const query = url.searchParams.get('q')?.slice(0, 200).trim();
          const data = query ? await subsonic(session, 'search3', { query, songCount: '0', albumCount: '30', artistCount: '0' }) : await subsonic(session, 'getAlbumList2', { type: 'random', size: '12' });
          const results = object(data[query ? 'searchResult3' : 'albumList2']).album;
          return Response.json(Array.isArray(results) ? results.map(album) : []);
        }
        if ((url.pathname === '/api/stream' || url.pathname === '/api/cover') && req.method === 'GET') {
          const mediaId = text(url.searchParams.get('id'));
          const stream = url.pathname === '/api/stream';
          const response = await fetch(urlFor(session, stream ? 'stream' : 'getCoverArt', { id: mediaId, ...(stream ? { format: 'raw' } : { size: '500' }) }), { headers: req.headers.has('range') && stream ? { Range: req.headers.get('range')! } : {}, signal: req.signal });
          const headers = new Headers({ 'Cache-Control': 'private, no-store' });
          for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const value = response.headers.get(key);
            if (value) headers.set(key, value);
          }
          return new Response(response.body, { status: response.status, headers });
        }
        if (url.pathname === '/api/control' && req.method === 'POST') {
          const body = object(await req.json());
          const playback = room(session.username);
          if (body.action === 'select' || body.action === 'enqueue' || body.action === 'playAlbum' || body.action === 'queueAlbum') {
            let selected: Song[];
            if (body.action === 'playAlbum' || body.action === 'queueAlbum') {
              const tracks = object((await subsonic(session, 'getAlbum', { id: text(body.id) })).album).song;
              selected = Array.isArray(tracks) ? tracks.map(song) : [];
              if (!selected.length) throw new HttpError(400, 'This album has no playable tracks.');
            } else selected = [song((await subsonic(session, 'getSong', { id: text(body.id) })).song)];
            const append = body.action === 'enqueue' || body.action === 'queueAlbum';
            if (selected.length + (append ? playback.queue.length : 0) > 1000) throw new HttpError(400, 'Queue limit is 1000 tracks.');
            if (append) {
              playback.position = position(playback);
              playback.queue.push(...selected);
            } else {
              playback.queue = selected; playback.index = 0; playback.position = 0; playback.playing = true;
            }
          } else if (body.action === 'next') {
            if (body.revision !== playback.revision) return Response.json(state(session));
            if (playback.index + 1 < playback.queue.length) { playback.index++; playback.position = 0; }
            else { playback.position = 0; playback.playing = false; }
          } else if (body.action === 'play' || body.action === 'pause') {
            playback.position = position(playback); playback.playing = body.action === 'play' && playback.queue.length > 0;
          } else if (body.action === 'seek') {
            if (typeof body.position !== 'number' || !Number.isFinite(body.position)) throw new HttpError(400, 'Invalid position.');
            playback.position = Math.max(0, Math.min(body.position, playback.queue[playback.index]?.duration ?? 0));
          } else throw new HttpError(400, 'Unknown control.');
          playback.updatedAt = Date.now(); playback.revision++;
          return Response.json(state(session), { headers: { 'Cache-Control': 'no-store' } });
        }
        throw new HttpError(404, 'Not found.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      const file = url.pathname === '/' ? 'index.html' : url.pathname === '/client.js' ? 'client.js' : url.pathname === '/style.css' ? 'style.css' : undefined;
      if (!file) throw new HttpError(404, 'Not found.');
      return new Response(Bun.file(new URL(`../public/${file}`, import.meta.url)), { headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'" } });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof SyntaxError) return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
      console.error('Request failed:', error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[upstream]') : 'unknown error');
      return Response.json({ error: 'Could not reach Navidrome. Try again.' }, { status: 502 });
    }
  },
});
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id);
  for (const [ip, rate] of attempts) if (rate.until < now) attempts.delete(ip);
  for (const username of rooms.keys()) if (![...sessions.values()].some(s => s.username === username)) rooms.delete(username);
}, 60000).unref();
console.log(`navidrome-slop-sync listening on :${server.port}`);
