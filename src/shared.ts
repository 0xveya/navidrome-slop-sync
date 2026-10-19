export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverArt?: string;
}
export interface Album {
  id: string;
  name: string;
  artist: string;
  songCount: number;
}
export interface Playback {
  queue: Song[];
  index: number;
  playing: boolean;
  position: number;
  updatedAt: number;
  revision: number;
}
export interface RoomState extends Playback {
  username: string;
  listeners: number;
  serverTime: number;
}
