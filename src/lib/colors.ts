// Distinct, reasonably spaced palette for auto-assigning speaker colors.
export const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#0ea5a4", "#f032e6", "#84cc16", "#eab308", "#14b8a6",
  "#9a6324", "#ef4444", "#6366f1", "#d946ef", "#22c55e",
  "#f97316", "#06b6d4", "#a855f7", "#ec4899", "#64748b",
];

export function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length];
}

function rgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

// Readable foreground (near-black or near-white) for a given background.
export function textOn(hex: string): string {
  const [r, g, b] = rgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#141414" : "#ffffff";
}

// Translucent version of a color, for subtle row tints.
export function tint(hex: string, alpha = 0.16): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
