/**
 * Canvas does not repaint itself when a web font finishes loading. Explicitly
 * await the postcard font before measuring text, drawing a preview or exporting
 * an image so that the saved blessing uses the same lettering as the preview.
 */
export const POSTCARD_BLESSING_FONT = 'Album Caslon';

export async function loadPostcardFont(text: string): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) {
    throw new Error('This browser cannot load the postcard font.');
  }

  const faces = await document.fonts.load(
    `48px "${POSTCARD_BLESSING_FONT}"`,
    text.trim() || 'May your days be filled with light.',
  );

  // FontFaceSet.check also returns true for a missing family that would fall
  // back to a system font; require a real, successfully loaded face instead.
  if (!faces.some((face) => face.status === 'loaded')) {
    throw new Error('The postcard font could not be loaded. Please try again.');
  }
}
