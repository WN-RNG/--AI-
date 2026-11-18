# Interface typography

The interface is English only. The homepage and studio language buttons have been removed, and the obsolete remembered Chinese preference is cleared on startup. The internal copy lookup remains to map existing labels and known service errors to English; it does not translate authored album titles, filenames, photographer names or captions.

## Shared rules

| Use | Font | Size | Alignment |
| --- | --- | --- | --- |
| Body, notes, buttons, inputs, navigation, filenames and dates | Adobe Caslon Pro Regular (`Album Caslon`) | 16px | Left |
| Page, section and dialog headings | Same | 32px | Left |

Chinese characters in authored content use the single declared `Microsoft YaHei` fallback when it is available on the device. English interface labels use the bundled Caslon font, including on mobile. No italic, handwriting, alternative Latin face, or responsive font-size scaling is active. Browser zoom remains available.

`src/typography.css` is loaded last and defines the final typography policy for existing components, including dialogs and the photo viewer. The two size tokens are `--type-body` and `--type-title`. The photo viewer's filename is a metadata label and uses the 16px body size.

Postcard text uses the same regular Caslon font and is left aligned. Because it is drawn into an exported bitmap, it scales proportionally with the selected image resolution; it is not a separate browser heading size. Source photos and generated artwork remain unchanged.

## Scope

This update affects interface copy, font loading, text styles, postcard text, and the English HTML shown before React loads. It does not change photo permissions, stored album data, upload limits or model calls. Earlier Allura and italic font files remain available in the repository but are no longer registered or used by the interface.
