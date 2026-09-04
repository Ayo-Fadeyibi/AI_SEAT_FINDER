import type { OccupancyStatus, AmenityType } from "./api";

/** Shared visual language: dark sidebar #111110/cream #F0EDE6, gold accent
 * #C8A84B, available green / occupied red. Used by the finder (App.tsx)
 * and the admin floor-plan editor so both stay visually consistent. */
export const PALETTE = {
  dark: "#111110",
  cream: "#F0EDE6",
  gold: "#C8A84B",
  available: "#3D8B5E",
  occupied: "#B94040",
  projector: "#5B7FA6",
  bgLight: "#FAFAF8",
  amenity: "#5B7FA6",
  pin: "#C8A84B",
} as const;

export const STATUS_COLOR: Record<OccupancyStatus, string> = {
  available: PALETTE.available,
  occupied: PALETTE.occupied,
};

// Mirrors LayoutEditor.tsx's Add Table/Add Seat sizing convention — keep
// in sync with scripts/normalize_seat_layout.py's DEFAULT_SEAT_SIZE.
export const DEFAULT_SEAT_SIZE = 22;
export const DEFAULT_AMENITY_SIZE = 30;

/** Short, font-safe glyph drawn on the map for each amenity kind — plain
 * text rather than icons, since nothing else on the SVG floor map renders
 * icons (avoids relying on emoji-glyph availability across environments). */
export const AMENITY_ABBR: Record<AmenityType, string> = {
  toilet: "WC",
  exit: "EXIT",
  elevator: "LIFT",
  stairs: "STAIRS",
  water_fountain: "WATER",
  printer: "PRINT",
  entrance: "ENTRY",
  help_desk: "HELP",
  other: "•",
};

export const AMENITY_TYPES: AmenityType[] = [
  "toilet", "exit", "elevator", "stairs", "water_fountain", "printer", "entrance", "help_desk", "other",
];

const CHAR_WIDTH_RATIO = 0.62; // JetBrains Mono glyph width ≈ 0.62em

/** Largest monospace font size (clamped to [minSize, maxSize]) that keeps `text` within `boxWidth` px. */
export function fitFontSize(text: string, boxWidth: number, maxSize: number, minSize = 5.2): number {
  const available = Math.max(boxWidth - 6, 4);
  const size = available / (text.length * CHAR_WIDTH_RATIO);
  return Math.min(maxSize, Math.max(minSize, size));
}

/**
 * Fits `text` into `boxWidth` without ever shrinking below `minSize` —
 * shrinking a label down to 4-5px "fits" in the geometric sense but stops
 * being readable. Past that floor, truncate the text with an ellipsis
 * instead of continuing to shrink, so the font size stays legible and only
 * very long labels in narrow boxes lose characters (as "…") rather than
 * legibility.
 */
export function fitLabel(text: string, boxWidth: number, maxSize: number, minSize: number): { text: string; fontSize: number } {
  const available = Math.max(boxWidth - 6, 4);
  const neededSize = available / (text.length * CHAR_WIDTH_RATIO);
  if (neededSize >= minSize) {
    return { text, fontSize: Math.min(maxSize, neededSize) };
  }
  const maxChars = Math.max(1, Math.floor(available / (minSize * CHAR_WIDTH_RATIO)));
  const truncated = text.length > maxChars ? text.slice(0, Math.max(1, maxChars - 1)) + "…" : text;
  return { text: truncated, fontSize: minSize };
}
