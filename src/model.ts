export type SourceType = 'folder' | 'm3u' | 'xtream' | 'stalker' | 'direct';
export type MediaKind = 'film' | 'episode' | 'channel' | 'music' | 'photo';

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
}

export interface SourceInput {
  name: string;
  type: SourceType;
  location?: string;
}

export interface ImportItem {
  kind: MediaKind;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  externalId?: string;
  sourceRef: string;
  url: string;
  quality?: string;
  group?: string;
  region?: string;
  artwork?: string;
}

export interface MediaRow {
  id: number;
  kind: MediaKind;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  group_name: string | null;
  artwork: string | null;
  source_count: number;
  favourite: number;
  position_seconds: number | null;
}
