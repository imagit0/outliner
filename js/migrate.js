// One-time data changes that must apply exactly once per line, even with
// several devices running them independently.

// Line colors went from six (red→green) to nine (red→green) in version 37.
// Lines last changed before that release hold the old scale; they're moved
// to the nearest spot on the new one: 1 2 3 4 5 6 → 1 3 4 6 7 9.
// A remapped line gets a fresh modified time, so it is never remapped again
// (on this device or, after syncing, on another), and two devices remapping
// the same line make the same change, which merges cleanly.
export const COLORS9_CUTOFF = Date.UTC(2026, 9, 22, 13, 26, 36); // v37 commit, 07:26:36 -06:00
const COLORS9_MAP = [0, 1, 3, 4, 6, 7, 9];

export function remapColors9(outline, cutoff = COLORS9_CUTOFF) {
  const old = Object.values(outline.nodes).filter((n) => n.cl >= 1 && n.cl <= 6 && (n.m || 0) < cutoff);
  for (const n of old) outline.update(n.id, { cl: COLORS9_MAP[n.cl] });
  return old.length;
}
