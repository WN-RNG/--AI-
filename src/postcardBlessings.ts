/** Short, original English blessings. Artwork text stays authored English in either UI language. */
export const postcardBlessings = [
  'May your days be filled with light and gentle moments.',
  'May you find a little wonder wherever life takes you.',
  'May the quiet moments bring you lasting joy.',
  'May every new horizon hold something beautiful for you.',
  'May your heart always have a peaceful place to rest.',
  'May warmth and kindness find you, wherever you are.',
  'May the memories you keep bring you softly home.',
  'May you carry a little sunlight into every tomorrow.',
  'May your dreams grow as freely as the morning light.',
  'May beautiful things find their way into your days.',
  'May you always have time for what makes you smile.',
  'May this little moment stay with you, warm and bright.',
] as const;

/** Pick a stable starting blessing for a photograph, without analysing or uploading its content. */
export function initialPostcardBlessing(photoId: string): string {
  let hash = 0;
  for (const character of photoId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return postcardBlessings[hash % postcardBlessings.length];
}

export function nextPostcardBlessing(current: string): string {
  const index = postcardBlessings.findIndex((blessing) => blessing === current);
  return postcardBlessings[(index + 1) % postcardBlessings.length];
}
