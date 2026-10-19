import type { Album, RoomState, Song } from './shared';

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}
const audio = element<HTMLAudioElement>('audio');
const seek = element<HTMLInputElement>('seek');
const play = element<HTMLButtonElement>('play');
const enable = element<HTMLButtonElement>('enable');
let current: RoomState | undefined;
let offset = 0;
let active = false;
let enabled = false;
let loadedSong = '';
let syncing = false;
let requestId = 0;
let busy = false;
let lastRevision = -1;
let autoplayBlocked = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function message(value = '') { element('message').textContent = value; }
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 && active) signOutView();
    throw new Error(typeof data === 'object' && data && 'error' in data ? String(data.error) : 'Something went wrong.');
  }
  return data as T;
}
function expected(): number {
  if (!current) return 0;
  return Math.min(current.queue[current.index]?.duration ?? 0, current.position + (current.playing ? Math.max(0, (Date.now() + offset - current.updatedAt) / 1000) : 0));
}
function clock(value: number) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
function showRoom() {
  active = true;
  element('login-view').hidden = true;
  element('room-view').hidden = false;
}
function signOutView() {
  active = false; enabled = false; current = undefined; loadedSong = ''; lastRevision = -1;
  clearTimeout(pollTimer); audio.pause(); audio.removeAttribute('src'); audio.load();
  element('room-view').hidden = true; element('login-view').hidden = false;
}
function render(state: RoomState, started = Date.now()) {
  if (current && state.revision < current.revision) return;
  current = state;
  offset = state.serverTime - (started + Date.now()) / 2;
  showRoom();
  element('presence').textContent = `${state.username} · ${state.listeners > 1 ? `${state.listeners} listening together` : 'Just you for now'}`;
  const song = state.queue[state.index];
  element('title').textContent = song?.title ?? 'No song selected';
  element('artist').textContent = song ? `${song.artist}${song.album ? ` · ${song.album}` : ''}` : 'Search for a song below.';
  play.disabled = !song; element<HTMLButtonElement>('next').disabled = !song;
  play.textContent = state.playing ? 'Pause' : 'Play'; play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  seek.disabled = !song; seek.max = String(song?.duration || 1);
  element('duration').textContent = clock(song?.duration ?? 0);
  element('playback-status').textContent = state.playing ? 'Playing' : 'Paused';
  if (song?.id !== loadedSong) {
    loadedSong = song?.id ?? '';
    audio.pause();
    const cover = element<HTMLImageElement>('cover');
    cover.hidden = !song?.coverArt; element('empty-art').hidden = !!song?.coverArt;
    if (song?.coverArt) cover.src = `/api/cover?id=${encodeURIComponent(song.coverArt)}`;
    if (song) { audio.src = `/api/stream?id=${encodeURIComponent(song.id)}`; audio.load(); }
  }
  if (lastRevision !== state.revision) {
    lastRevision = state.revision;
    const queue = element('queue'); queue.replaceChildren();
    for (const item of state.queue.slice(state.index + 1)) {
      const li = document.createElement('li'); li.textContent = `${item.title} · ${item.artist}`; queue.append(li);
    }
    element('queue-count').textContent = String(state.queue.length - state.index - (song ? 1 : 0));
  }
  enable.hidden = !song || (enabled && !autoplayBlocked);
  void syncAudio();
}
async function syncAudio() {
  if (syncing || !current || !loadedSong || audio.readyState < 1) return;
  syncing = true;
  try {
    const target = expected();
    if (Math.abs(audio.currentTime - target) > 1.2) audio.currentTime = target;
    if (!current.playing) audio.pause();
    else if (enabled && audio.paused && !autoplayBlocked) {
      try { await audio.play(); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) { autoplayBlocked = true; enable.hidden = false; }
      }
    }
  } finally { syncing = false; }
}
async function unlock() {
  enabled = true; autoplayBlocked = false; enable.hidden = true;
  if (syncing || !audio.src || !current?.playing) return;
  syncing = true;
  try {
    if (audio.readyState >= 1 && Math.abs(audio.currentTime - expected()) > 1.2) audio.currentTime = expected();
    await audio.play();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) { autoplayBlocked = true; enable.hidden = false; }
  } finally { syncing = false; }
}

async function control(body: object) {
  if (busy) return;
  busy = true;
  try { const started = Date.now(); render(await api<RoomState>('control', body), started); message(); }
  catch (error) { message(error instanceof Error ? error.message : 'Could not update playback.'); }
  finally { busy = false; }
}
async function poll() {
  if (!active) return;
  try { const started = Date.now(); render(await api<RoomState>('state'), started); }
  catch (error) { if (active) message(error instanceof Error ? error.message : 'Connection lost. Reconnecting…'); }
  if (active) pollTimer = setTimeout(poll, 1000);
}
function renderSongs(songs: Song[]) {
  const container = element('songs'); container.replaceChildren();
  if (!songs.length) { const p = document.createElement('p'); p.textContent = 'No songs found. Try another search.'; container.append(p); }
  for (const song of songs) {
    const row = document.createElement('div'); row.className = 'song';
    const pick = document.createElement('button'); pick.className = 'song-pick'; pick.setAttribute('aria-label', `Play ${song.title} by ${song.artist}`);
    if (song.coverArt) { const img = document.createElement('img'); img.src = `/api/cover?id=${encodeURIComponent(song.coverArt)}`; img.alt = ''; img.loading = 'lazy'; pick.append(img); }
    else { const art = document.createElement('span'); art.className = 'song-placeholder'; art.textContent = '♫'; pick.append(art); }
    const info = document.createElement('span'); info.className = 'song-info';
    const title = document.createElement('strong'); title.textContent = song.title;
    const artist = document.createElement('small'); artist.textContent = `${song.artist} · ${clock(song.duration)}`;
    info.append(title, artist); pick.append(info);
    pick.addEventListener('click', () => { void unlock(); void control({ action: 'select', id: song.id }); });
    const add = document.createElement('button'); add.className = 'song-add'; add.textContent = '+'; add.setAttribute('aria-label', `Queue ${song.title}`);
    add.addEventListener('click', () => void control({ action: 'enqueue', id: song.id }));
    row.append(pick, add); container.append(row);
  }
}
function renderAlbums(albums: Album[]) {
  const container = element('albums'); container.replaceChildren();
  if (!albums.length) { const p = document.createElement('p'); p.textContent = 'No albums found.'; container.append(p); }
  for (const album of albums) {
    const row = document.createElement('div'); row.className = 'album';
    const name = document.createElement('p'); name.textContent = `${album.name} · ${album.artist} (${album.songCount} tracks)`;
    const playAlbum = document.createElement('button'); playAlbum.textContent = 'Play album'; playAlbum.setAttribute('aria-label', `Play album ${album.name}`);
    playAlbum.addEventListener('click', () => { void unlock(); void control({ action: 'playAlbum', id: album.id }); });
    const queueAlbum = document.createElement('button'); queueAlbum.textContent = 'Queue album'; queueAlbum.setAttribute('aria-label', `Queue album ${album.name}`);
    queueAlbum.addEventListener('click', () => void control({ action: 'queueAlbum', id: album.id }));
    row.append(name, playAlbum, document.createTextNode(' '), queueAlbum); container.append(row);
  }
}
async function search() {
  const id = ++requestId;
  const query = element<HTMLInputElement>('query').value.trim();
  element('results-label').textContent = 'Loading…';
  try {
    const [songs, albums] = await Promise.all([api<Song[]>(`songs?q=${encodeURIComponent(query)}`), api<Album[]>(`albums?q=${encodeURIComponent(query)}`)]);
    if (id !== requestId || !active) return;
    renderSongs(songs); renderAlbums(albums); element('results-label').textContent = query ? `${songs.length} songs, ${albums.length} albums found` : 'Random picks';
  } catch (error) { message(error instanceof Error ? error.message : 'Could not load songs.'); }
}
element<HTMLFormElement>('login').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector('button')!; button.disabled = true; message('Opening your room…');
  const data = new FormData(form);
  try {
    const started = Date.now();
    render(await api<RoomState>('login', { username: data.get('username'), password: data.get('password') }), started);
    form.reset(); message(); void search(); void poll();
  } catch (error) { message(error instanceof Error ? error.message : 'Could not sign in.'); }
  finally { button.disabled = false; }
});
element('logout').addEventListener('click', async () => {
  try { await api('logout', {}); signOutView(); message(); }
  catch (error) { message(error instanceof Error ? error.message : 'Could not sign out.'); }
});
element('search').addEventListener('submit', event => { event.preventDefault(); void search(); });
element('shuffle').addEventListener('click', () => { element<HTMLInputElement>('query').value = ''; void search(); });
play.addEventListener('click', () => { void unlock(); void control({ action: current?.playing ? 'pause' : 'play' }); });
enable.addEventListener('click', () => void unlock());
element('next').addEventListener('click', () => void control({ action: 'next', revision: current?.revision }));
seek.addEventListener('change', () => void control({ action: 'seek', position: Number(seek.value) }));
audio.addEventListener('loadedmetadata', () => void syncAudio());
audio.addEventListener('ended', () => { if (current?.playing) void control({ action: 'next', revision: current.revision }); });
audio.addEventListener('error', () => { if (loadedSong) message('This song could not play. Try another track.'); });
element<HTMLImageElement>('cover').addEventListener('error', () => { element('cover').hidden = true; element('empty-art').hidden = false; });
element('invite').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.origin); message('Invite copied. Sign in with the same Navidrome account to join.'); }
  catch { message(`Open ${location.origin} on the other phone and sign into the same account.`); }
});
setInterval(() => {
  if (!current) return;
  const value = expected();
  if (document.activeElement !== seek) seek.value = String(value);
  element('elapsed').textContent = clock(value);
}, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden && active) { clearTimeout(pollTimer); void poll(); } });
void (async () => {
  try { const started = Date.now(); render(await api<RoomState>('state'), started); void search(); void poll(); }
  catch { /* A fresh browser starts at sign in. */ }
})();
