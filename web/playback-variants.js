const qualityThresholds = { auto: 0, fhd: 1, hd: 2, sd: 3 };

/** Preference changes which source is tried first; every connection remains selectable. */
export function orderPlaybackVariants(variants, preference = 'auto', preferredId = null) {
  const minimumRank = qualityThresholds[preference] ?? 0;
  const rank = variant => Number.isInteger(variant.qualityRank) && variant.qualityRank >= 0 && variant.qualityRank <= 4 ? variant.qualityRank : 4;
  const ordered = [...variants].sort((a,b) => {
    const aRank=rank(a),bRank=rank(b);
    const aDeferred=aRank<minimumRank ? 1 : 0,bDeferred=bRank<minimumRank ? 1 : 0;
    return aDeferred-bDeferred || aRank-bRank || Number(a.sourceId)-Number(b.sourceId) || Number(a.id)-Number(b.id);
  });
  if (preferredId != null) {
    const selected = ordered.findIndex(variant => Number(variant.id) === Number(preferredId));
    if (selected > 0) ordered.unshift(ordered.splice(selected,1)[0]);
  }
  return ordered;
}

export function playbackVariantLabel(variant) {
  const quality = variant.qualityTier || 'Unknown';
  return `${quality === 'Unknown' ? 'Unspecified quality' : quality} · ${variant.name || 'Unnamed source'}`;
}
