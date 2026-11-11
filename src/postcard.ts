/** Browser-local postcard rendering. Only four sampled base colours are used for the backdrop. */
export type RGB = [number, number, number];
export type PaletteColor = { rgb: RGB; weight: number };
export type PostcardTemplate = 'A' | 'B' | 'C';
export type PostcardOrientation = 'auto' | 'landscape' | 'portrait';
export type PostcardLayout = {
  width: number;
  height: number;
  image: { x: number; y: number; width: number; height: number };
  mat: { x: number; y: number; width: number; height: number };
  captionY: number;
};

const clamp = (value: number, min = 0, max = 255) => Math.max(min, Math.min(max, value));
const luminance = (rgb: RGB) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

/** Small quantized sample and deterministic k-means; transparent pixels do not bias the palette. */
export function extractPalette(pixels: ArrayLike<number>): PaletteColor[] {
  const samples: RGB[] = [];
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 128) continue;
    samples.push([clamp(pixels[offset]), clamp(pixels[offset + 1]), clamp(pixels[offset + 2])]);
  }
  if (!samples.length) return [{ rgb: [210, 205, 191], weight: 1 }];
  samples.sort((a, b) => luminance(a) - luminance(b));
  let centers = [0.08, 0.35, 0.65, 0.92].map(
    (position) => [...samples[Math.floor((samples.length - 1) * position)]] as RGB,
  );
  let counts = new Array<number>(4).fill(0);
  for (let iteration = 0; iteration < 7; iteration++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = new Array<number>(4).fill(0);
    for (const sample of samples) {
      let nearest = 0;
      let best = Infinity;
      centers.forEach((center, index) => {
        const distance = sample.reduce((sum, channel, c) => sum + (channel - center[c]) ** 2, 0);
        if (distance < best) {
          nearest = index;
          best = distance;
        }
      });
      counts[nearest]++;
      sample.forEach((channel, c) => {
        sums[nearest][c] += channel;
      });
    }
    centers = centers.map((center, index) =>
      counts[index] ? (sums[index].map((channel) => channel / counts[index]) as RGB) : center,
    );
  }
  const merged = new Map<string, PaletteColor>();
  centers.forEach((center, index) => {
    if (!counts[index]) return;
    const rgb = center.map(Math.round) as RGB;
    const key = rgb.join(',');
    const previous = merged.get(key);
    merged.set(key, { rgb, weight: (previous?.weight ?? 0) + counts[index] / samples.length });
  });
  return [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, 4);
}

/** A visual recommendation, based on colour and shape; it does not claim to recognise the scene. */
export function recommendTemplate(
  palette: PaletteColor[],
  width: number,
  height: number,
): PostcardTemplate {
  const total = palette.reduce((sum, color) => sum + color.weight, 0) || 1;
  const brightness =
    palette.reduce((sum, color) => sum + luminance(color.rgb) * color.weight, 0) / total;
  const warmth =
    palette.reduce((sum, color) => sum + (color.rgb[0] - color.rgb[2]) * color.weight, 0) / total;
  if (brightness < 83) return 'C';
  if (warmth > 15 || height > width * 1.12) return 'B';
  return brightness > 143 || warmth < -9 ? 'A' : 'B';
}

/** Contain the full photo inside the mat, independently of the selected output orientation. */
export function postcardLayout(
  photoWidth: number,
  photoHeight: number,
  longEdge: number,
  orientation: PostcardOrientation,
): PostcardLayout {
  if (!(
    photoWidth > 0 &&
    photoHeight > 0 &&
    Number.isFinite(photoWidth) &&
    Number.isFinite(photoHeight)
  ))
    throw new Error('Invalid image size');
  const portrait =
    orientation === 'portrait' || (orientation === 'auto' && photoHeight > photoWidth);
  const edge = Math.round(clamp(longEdge, 320, 3600));
  const width = portrait ? Math.round(edge * 0.8) : edge;
  const height = portrait ? edge : Math.round((edge * 2) / 3);
  const padding = Math.min(width, height) * 0.045;
  const mat = { x: width * 0.07, y: height * 0.065, width: width * 0.86, height: height * 0.87 };
  const area = {
    x: mat.x + padding,
    y: mat.y + padding,
    width: mat.width - padding * 2,
    height: mat.height - padding * 2 - height * 0.135,
  };
  const fit = Math.min(area.width / photoWidth, area.height / photoHeight);
  const image = {
    x: area.x + (area.width - photoWidth * fit) / 2,
    y: area.y + (area.height - photoHeight * fit) / 2,
    width: photoWidth * fit,
    height: photoHeight * fit,
  };
  return { width, height, image, mat, captionY: mat.y + mat.height - height * 0.105 };
}

function canvas(width: number, height: number, sample = false) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d', { alpha: false, willReadFrequently: sample });
  if (!context) throw new Error('Canvas is not available');
  return { element, context };
}

export function imagePalette(image: ImageBitmap): PaletteColor[] {
  const sample = canvas(64, 64, true);
  sample.context.fillStyle = '#fffdf7';
  sample.context.fillRect(0, 0, 64, 64);
  sample.context.drawImage(image, 0, 0, 64, 64);
  const colors = extractPalette(sample.context.getImageData(0, 0, 64, 64).data);
  sample.element.width = sample.element.height = 1;
  return colors;
}

function rounded(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

function rgb(color: RGB, alpha = 1) {
  return `rgba(${color.join(',')},${alpha})`;
}

function captionLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  // Character wrapping also supports Chinese, filenames and long unbroken words.
  for (const character of Array.from(text.replace(/[\r\n]+/g, ' ').trim()).slice(0, 140)) {
    if (context.measureText(line + character).width > maxWidth && line) {
      lines.push(line.trim());
      line = character;
    } else line += character;
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && line) lines.push(line.trim());
  return lines;
}

export type PostcardRenderOptions = {
  template: PostcardTemplate;
  orientation: PostcardOrientation;
  longEdge: number;
  palette: PaletteColor[];
  caption: string;
  author: string;
  metadata: string;
};

/** Only the low-resolution backdrop is blurred; the contained photo is drawn afterwards, sharply. */
export function renderPostcard(
  target: HTMLCanvasElement,
  image: ImageBitmap,
  options: PostcardRenderOptions,
) {
  const layout = postcardLayout(image.width, image.height, options.longEdge, options.orientation);
  target.width = layout.width;
  target.height = layout.height;
  const context = target.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is not available');
  const { width, height, image: box, mat } = layout;
  const unit = Math.min(width, height) / 1000;
  const dark = options.template === 'C';
  const paper = options.template === 'B';
  const colors = options.palette.length
    ? options.palette.slice(0, 4)
    : [{ rgb: [210, 205, 191] as RGB, weight: 1 }];
  const toned = colors.map(
    ({ rgb: color }) =>
      color.map((value) =>
        Math.round(
          dark ? value * 0.42 : value * (paper ? 0.38 : 0.32) + 255 * (paper ? 0.62 : 0.68),
        ),
      ) as RGB,
  );
  const background = canvas(320, 240);
  background.context.fillStyle = rgb(toned[0]);
  background.context.fillRect(0, 0, 320, 240);
  const positions = [
    [0.05, 0.05],
    [0.95, 0.12],
    [0.85, 0.95],
    [0.1, 0.85],
  ];
  toned.forEach((color, index) => {
    const [x, y] = positions[index];
    const gradient = background.context.createRadialGradient(
      x * 320,
      y * 240,
      0,
      x * 320,
      y * 240,
      280,
    );
    gradient.addColorStop(0, rgb(color, 0.94));
    gradient.addColorStop(1, rgb(color, 0));
    background.context.fillStyle = gradient;
    background.context.fillRect(0, 0, 320, 240);
  });
  context.save();
  context.filter = `blur(${18 * unit}px)`;
  context.drawImage(background.element, -width * 0.05, -height * 0.05, width * 1.1, height * 1.1);
  context.restore();
  background.element.width = background.element.height = 1;

  context.save();
  context.shadowColor = dark ? '#00000066' : '#342d2633';
  context.shadowBlur = (paper ? 35 : 52) * unit;
  context.shadowOffsetY = (paper ? 15 : 20) * unit;
  context.fillStyle = dark ? '#171e21' : paper ? '#fffaf0' : '#ffffffa8';
  rounded(context, mat.x, mat.y, mat.width, mat.height, (paper ? 14 : 24) * unit);
  context.fill();
  context.restore();
  context.strokeStyle = dark ? '#ffffff35' : '#ffffffba';
  context.lineWidth = 1.5 * unit;
  rounded(context, mat.x, mat.y, mat.width, mat.height, (paper ? 14 : 24) * unit);
  context.stroke();

  context.save();
  rounded(context, box.x, box.y, box.width, box.height, (paper ? 8 : 15) * unit);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, box.x, box.y, box.width, box.height);
  context.restore();

  const textX = mat.x + mat.width * 0.06;
  const textWidth = mat.width * 0.88;
  context.fillStyle = dark ? '#f7f2e8' : '#342d26';
  context.font = `${paper ? 'italic ' : ''}${paper ? '400' : '500'} ${32 * unit}px ${paper ? "'Segoe Print', 'KaiTi', Georgia" : 'Georgia'}, serif`;
  const lines = captionLines(context, options.caption, textWidth);
  context.textAlign = paper ? 'left' : 'center';
  lines.forEach((line, index) =>
    context.fillText(
      line,
      paper ? textX : width / 2,
      layout.captionY + index * 35 * unit,
      textWidth,
    ),
  );
  context.font = `italic 400 ${22 * unit}px Georgia, 'KaiTi', serif`;
  context.fillStyle = dark ? '#d9d5cc' : '#6d655c';
  context.textAlign = 'left';
  const footerY = mat.y + mat.height - height * 0.025;
  const author = options.author
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 80);
  context.fillText(author, textX, footerY, textWidth * 0.46);
  context.textAlign = 'right';
  context.fillText(options.metadata, mat.x + mat.width * 0.94, footerY, textWidth * 0.5);
  return layout;
}

/** The export source always passes the current server download policy; public preview is insufficient. */
export async function authorizedPostcardBlob(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/photos/${encodeURIComponent(id)}/download`, {
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    headers: { 'X-Album-Client': '1' },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      typeof data?.error === 'string' ? data.error : `Export unavailable (${response.status})`,
    );
  }
  const blob = await response.blob();
  if (!/^image\/(jpeg|png|webp)$/i.test(blob.type)) throw new Error('Unsupported image response');
  return blob;
}

export function encodePostcard(
  target: HTMLCanvasElement,
  mime: 'image/png' | 'image/jpeg',
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    target.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))),
      mime,
      0.94,
    ),
  );
}
