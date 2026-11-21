export type SourceType = 'folder' | 'm3u' | 'xtream' | 'stalker' | 'direct';
export type MediaKind = 'film' | 'series' | 'episode' | 'channel' | 'music' | 'photo';

export interface ProviderConfig {
  username?: string;
  password?: string;
  mac?: string;
  serial?: string;
  deviceId?: string;
  deviceId2?: string;
  allowLan?: boolean;
}

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
}

export interface SourceInput {
  name: string;
  type: SourceType;
  location?: string;
  config?: ProviderConfig;
}

export interface ImportItem {
  kind: MediaKind;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  episodeName?: string;
  externalId?: string;
  sourceRef: string;
  url: string;
  quality?: string;
  group?: string;
  region?: string;
  artwork?: string;
  description?: string;
  genres?: string;
  rating?: number | null;
  durationSeconds?: number | null;
  imdbId?: string;
  tmdbId?: string;
}

export interface ProviderCategory {
  source_id: number;
  kind: 'live' | 'vod' | 'series';
  category_id: string;
  name: string;
  selected: number;
}

export interface GuideProgramme {
  title: string;
  description: string;
  start: string;
  end: string;
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
