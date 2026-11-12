/** Browser-local postcard rendering. Only four sampled base colours are used for the backdrop. */
export type RGB = [number, number, number];
export type PaletteColor = { rgb: RGB; weight: number };
export type PostcardTemplate = 'frost' | 'watercolor';
export type PostcardOrientation = 'auto' | 'landscape' | 'portrait';
export type PostcardLayout = {
  width: number;
  height: number;
  image: { x: number; y: number; width: number; height: number };
  caption: { x: number; y: number; width: number; height: number };
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

/** Follow the photograph when automatic; explicit orientation never crops the original. */
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
  const edge = Math.round(clamp(longEdge, 320, 3600));
  const ratio =
    orientation === 'portrait'
      ? 0.8
      : orientation === 'landscape'
        ? 1.5
        : clamp(1 / (0.92 / (photoWidth / photoHeight) + 0.155), 0.56, 1.6);
  const width = ratio >= 1 ? edge : Math.round(edge * ratio);
  const height = ratio >= 1 ? Math.round(edge / ratio) : edge;
  const padding = Math.min(width, height) * 0.04;
  const captionHeight = Math.max(height * 0.075, Math.min(width, height) * 0.12);
  const area = {
    x: padding,
    y: padding,
    width: width - padding * 2,
    height: height - padding * 2 - captionHeight,
  };
  const fit = Math.min(area.width / photoWidth, area.height / photoHeight);
  const image = {
    x: area.x + (area.width - photoWidth * fit) / 2,
    y: area.y + (area.height - photoHeight * fit) / 2,
    width: photoWidth * fit,
    height: photoHeight * fit,
  };
  const caption = {
    x: padding,
    y: height - padding - captionHeight,
    width: width - padding * 2,
    height: captionHeight,
  };
  return { width, height, image, caption, captionY: caption.y + caption.height * 0.45 };
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
  // Keep English words together; a long unbroken word is scaled by Canvas at draw time.
  for (const word of text
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 140)
    .split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > maxWidth && line && lines.length === 0) {
      lines.push(line);
      line = word;
    } else line = next;
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
  background?: CanvasImageSource;
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
  const { width, height, image: box } = layout;
  const unit = Math.min(width, height) / 1000;
  const colors = options.palette.length
    ? options.palette.slice(0, 4)
    : [{ rgb: [210, 205, 191] as RGB, weight: 1 }];
  const averageLight = colors.reduce((sum, color) => sum + luminance(color.rgb) * color.weight, 0);
  const dark = averageLight < 140;
  const toned = colors.map(
    ({ rgb: color }) =>
      color.map((value) => Math.round(dark ? value * 0.58 : value * 0.68 + 255 * 0.32)) as RGB,
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

  if (options.template === 'watercolor') {
    context.fillStyle = '#f5eedf';
    context.fillRect(0, 0, width, height);
  } else if (options.background) {
    context.save();
    context.filter = `blur(${4 * unit}px)`;
    context.drawImage(
      options.background,
      -width * 0.01,
      -height * 0.01,
      width * 1.02,
      height * 1.02,
    );
    context.restore();
    const shade = context.createLinearGradient(0, height * 0.65, 0, height);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.42)');
    context.fillStyle = shade;
    context.fillRect(0, 0, width, height);
  }

  context.save();
  context.shadowColor = dark ? '#00000055' : '#342d2638';
  context.shadowBlur = 32 * unit;
  context.shadowOffsetY = 12 * unit;
  context.fillStyle = '#ffffff33';
  rounded(context, box.x, box.y, box.width, box.height, 13 * unit);
  context.fill();
  context.restore();

  context.save();
  rounded(context, box.x, box.y, box.width, box.height, 13 * unit);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, box.x, box.y, box.width, box.height);
  context.restore();
  context.strokeStyle = dark ? '#ffffff55' : '#ffffffa8';
  context.lineWidth = 1.2 * unit;
  rounded(context, box.x, box.y, box.width, box.height, 13 * unit);
  context.stroke();

  const textWidth = layout.caption.width * 0.94;
  let fontSize = 49 * unit;
  context.fillStyle =
    options.template === 'watercolor'
      ? '#4a504c'
      : options.background || dark
        ? '#fffaf0'
        : '#2f3836';
  context.font = `400 ${fontSize}px "Album Blessing", cursive`;
  const lines = captionLines(context, options.caption, textWidth);
  const lineHeight = fontSize * 1.02;
  const widest = Math.max(1, ...lines.map((line) => context.measureText(line).width));
  // Long edited blessings still fit without clipping or dropping the last words.
  if (widest > textWidth) {
    fontSize *= textWidth / widest;
    context.font = `400 ${fontSize}px "Album Blessing", cursive`;
  }
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const startY =
    layout.caption.y + layout.caption.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) =>
    context.fillText(line, width / 2, startY + index * lineHeight, textWidth),
  );
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
