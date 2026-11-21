/** Local files need separate browser surfaces, not video transcoding. */
export function presentation(kind) {
  return kind==='music' ? 'audio' : kind==='photo' ? 'photo' : 'video';
}

/** Keep the order of the visible Library page, independent of the detail view. */
export function mediaQueue(items,kind) {
  if (!['music','photo'].includes(kind)) return [];
  const seen=new Set();
  return items.filter(item=>item.kind===kind && Number.isSafeInteger(Number(item.id)) && Number(item.id)>0)
    .map(item=>Number(item.id)).filter(id=>{if(seen.has(id)) return false;seen.add(id);return true;});
}

export function adjacentMedia(queue,currentId,direction) {
  if (direction!==-1 && direction!==1) return null;
  const index=queue.indexOf(Number(currentId));
  return index<0 ? null : (queue[index+direction] ?? null);
}
