export type QualityTier = '4K' | 'FHD' | 'HD' | 'SD' | 'Unknown';
export type QualityPreference = 'auto' | 'fhd' | 'hd' | 'sd';
export const qualityPreferences = ['auto','fhd','hd','sd'] as const;
const tiers: QualityTier[] = ['4K','FHD','HD','SD','Unknown'];

/** Explicit provider labels win; category names or local filenames are a fallback. */
export function qualityTier(explicit: string, context = ''): QualityTier {
  const label = (explicit || '').toUpperCase();
  const fallback = (context || '').toUpperCase();
  const detect = (value: string): QualityTier | null => {
    if (/(?:^|[^A-Z0-9])(?:4K|UHD|2160P|ULTRA[\s-]*HD)(?=$|[^A-Z0-9])/.test(value)) return '4K';
    if (/(?:^|[^A-Z0-9])(?:FHD|1080P|FULL[\s-]*HD)(?=$|[^A-Z0-9])/.test(value)) return 'FHD';
    if (/(?:^|[^A-Z0-9])(?:HD|720P)(?=$|[^A-Z0-9])/.test(value)) return 'HD';
    if (/(?:^|[^A-Z0-9])(?:SD|480P|576P)(?=$|[^A-Z0-9])/.test(value)) return 'SD';
    return null;
  };
  return detect(label) || detect(fallback) || 'Unknown';
}

export function qualityRank(tier: QualityTier): number { return tiers.indexOf(tier); }
