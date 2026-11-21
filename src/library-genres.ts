/** Small, fixed set of user-facing Library genres; never trust provider strings as SQL identifiers. */
export const libraryGenres = [
  'Action', 'Adventure', 'Animation', 'Anime', 'Biography', 'Comedy', 'Crime',
  'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music',
  'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western', 'Other',
] as const;

const labels: Array<[typeof libraryGenres[number], RegExp]> = [
  ['Action', /\baction\b/],
  ['Adventure', /\badventures?\b/],
  ['Animation', /\banimat(?:ion|ed)\b|\bcartoons?\b/],
  ['Anime', /\banime\b/],
  ['Biography', /\bbiograph(?:y|ical|ies)\b|\bbiopic\b/],
  ['Comedy', /\bcomed(?:y|ies)\b|\bcomedic\b/],
  ['Crime', /\bcrime\b|\bcriminal\b|\bnoir\b/],
  ['Documentary', /\bdocumentar(?:y|ies)\b|\bdocu\b/],
  ['Drama', /\bdramas?\b/],
  ['Family', /\bfamil(?:y|ies)\b|\bkids?\b|\bchildren(?:s)?\b/],
  ['Fantasy', /\bfantas(?:y|ies)\b/],
  ['History', /\bhistor(?:y|ical)\b/],
  ['Horror', /\bhorrors?\b/],
  ['Music', /\bmusic\b/],
  ['Musical', /\bmusicals?\b/],
  ['Mystery', /\bmyster(?:y|ies)\b/],
  ['Romance', /\bromanc(?:e|es)\b|\bromantic\b/],
  ['Sci-Fi', /\bsci\s?fi\b|\bscience fiction\b/],
  ['Sport', /\bsports?\b/],
  ['Thriller', /\bthrillers?\b|\bsuspense\b/],
  ['War', /\bwars?\b|\bmilitary\b/],
  ['Western', /\bwesterns?\b/],
];

/** A title can belong to multiple genres. Unknown categories stay in Other, not a made-up genre. */
export function classifyLibraryGenres(raw: string): string[] {
  const text = raw.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!text) return ['Other'];
  const found = labels.filter(([, pattern]) => pattern.test(text)).map(([genre]) => genre);
  return found.length ? found : ['Other'];
}
