/** Homepage covers have an independent, display-only manifest, never user photo IDs. */
export interface CoverSlide {
  id: string;
  url: string;
  title: string;
  subtitle: string;
  author: string;
  source: string;
  credit: string;
  displayOnly: true;
  focalPoint: { x: number; y: number };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f]/.test(value)
    ? value.trim()
    : null;
}

function sourceLink(value: unknown): string | null {
  const source = boundedText(value, 4096);
  if (source === null || !source) return source;
  try {
    const parsed = new URL(source);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function focalCoordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 50;
}

/** Strict public-field whitelist. Malformed/duplicate entries never reach the image tree. */
export function parseCoverManifest(value: unknown): CoverSlide[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.slides)) return [];
  const slides: CoverSlide[] = [];
  const ids = new Set<string>();
  for (const input of value.slides) {
    if (!record(input) || input.displayOnly !== true) continue;
    const id = boundedText(input.id, 64);
    const url = boundedText(input.url, 300);
    const title = boundedText(input.title, 240);
    const author = boundedText(input.author, 240);
    const credit = boundedText(input.credit, 240);
    const subtitle = input.subtitle === undefined ? '' : boundedText(input.subtitle, 240);
    const source = sourceLink(input.source);
    if (
      !id ||
      !/^[a-zA-Z0-9_-]+$/.test(id) ||
      ids.has(id) ||
      !url ||
      !/^\/covers\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:webp|jpg|jpeg|png)$/.test(url) ||
      !title ||
      author === null ||
      credit === null ||
      subtitle === null ||
      source === null
    )
      continue;
    const focal = record(input.focalPoint) ? input.focalPoint : {};
    slides.push({
      id,
      url,
      title,
      subtitle,
      author,
      source,
      credit,
      displayOnly: true,
      focalPoint: { x: focalCoordinate(focal.x), y: focalCoordinate(focal.y) },
    });
    ids.add(id);
    if (slides.length === 50) break;
  }
  return slides;
}

export interface CoverState {
  slides: CoverSlide[];
  fallback: CoverSlide[];
  usingFallback: boolean;
  activeId: string | null;
  previousId: string | null;
  failedIds: string[];
  readyIds: string[];
}

export type CoverAction =
  | { type: 'replace'; slides: CoverSlide[] }
  | { type: 'ready' | 'failed'; id: string; url: string }
  | { type: 'advance' };

export function initialCoverState(fallback: CoverSlide[]): CoverState {
  return {
    slides: fallback,
    fallback,
    usingFallback: true,
    activeId: fallback[0]?.id ?? null,
    previousId: null,
    failedIds: [],
    readyIds: [],
  };
}

export function coverFrame(state: CoverState) {
  const usable = state.slides.filter((slide) => !state.failedIds.includes(slide.id));
  const active = usable.find((slide) => slide.id === state.activeId);
  const activeIndex = active ? usable.indexOf(active) : -1;
  const next = activeIndex >= 0 ? usable[(activeIndex + 1) % usable.length] : undefined;
  // Retain already loaded/previous elements for the crossfade. Never render an undefined src.
  const visibleIds = new Set([...state.readyIds, state.activeId, state.previousId, next?.id]);
  const requested = usable.filter((slide) => visibleIds.has(slide.id));
  return { usable, active, next, requested };
}

/** Pure transitions make failed-source fallback and preloading behavior independently testable. */
export function reduceCoverState(state: CoverState, action: CoverAction): CoverState {
  if (action.type === 'replace') {
    if (!action.slides.length) return state;
    return {
      ...initialCoverState(state.fallback),
      slides: action.slides,
      usingFallback: false,
      activeId: action.slides[0].id,
      // A manifest may retain bundled covers. React reuses those loaded <img> elements,
      // so their load events will not fire again when only the list changes.
      readyIds: state.readyIds.filter((id) => {
        const previous = state.slides.find((slide) => slide.id === id);
        return action.slides.some((slide) => slide.id === id && slide.url === previous?.url);
      }),
    };
  }
  if (action.type === 'advance') {
    const { next, active } = coverFrame(state);
    // A slow next image must not fade the current photograph into an empty screen.
    if (!next || next.id === active?.id || !state.readyIds.includes(next.id)) return state;
    return { ...state, previousId: active?.id ?? null, activeId: next.id };
  }
  const slide = state.slides.find(
    (candidate) => candidate.id === action.id && candidate.url === action.url,
  );
  if (!slide || state.failedIds.includes(action.id)) return state;
  if (action.type === 'ready') {
    return state.readyIds.includes(slide.id)
      ? state
      : { ...state, readyIds: [...state.readyIds, slide.id] };
  }
  const failedIds = [...state.failedIds, slide.id];
  const usable = state.slides.filter((candidate) => !failedIds.includes(candidate.id));
  if (!usable.length && !state.usingFallback) return initialCoverState(state.fallback);
  return {
    ...state,
    failedIds,
    readyIds: state.readyIds.filter((id) => id !== slide.id),
    activeId: slide.id === state.activeId ? (usable[0]?.id ?? null) : state.activeId,
    previousId: slide.id === state.previousId ? null : state.previousId,
  };
}
