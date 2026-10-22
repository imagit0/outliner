// One-time data changes that must apply exactly once per line, even with
// several devices running them independently.

// Line colors, by release:
//   up to v36  six colors: red, orange, yellow, green, blue, purple (as in
//              Dynalist, where most lines were colored)
//   v37–v38    nine colors running red → green; v38 also remapped older
//              lines 1 2 3 4 5 6 → 1 3 4 6 7 9
//   v39        1–5 red → green, then 6 blue, 7 purple, 8 pink, 9 gray
// A line's modified time tells which scale its color was set on. Each line
// is moved to the color it meant: the original six keep their hue (green
// → 5, blue → 6, purple → 7); colors picked on the v37 scale go to the
// nearest red → green step. A remapped line gets a fresh modified time, so
// it is never remapped again (here or, after syncing, on another device), and
// two devices remapping the same line make the same change, which merges
// cleanly.
export const V37 = 1792675596000; // 2026-10-22 07:26:36 -06:00
export const V38 = 1792675804000; // 2026-10-22 07:30:04 -06:00
export const V39 = 1792676751479; // 2026-10-22 07:45:51 -06:00 (release)

const FROM_ORIGINAL = [0, 1, 2, 3, 5, 6, 7];
const FROM_V38_REMAP = { 1: 1, 3: 2, 4: 3, 6: 5, 7: 6, 9: 7 }; // undo v38, then as above
const FROM_V37_SCALE = [0, 1, 2, 2, 3, 3, 3, 4, 5, 5];

export function newColor(cl, m = 0, cuts = { V37, V38, V39 }) {
  if (!(cl >= 1 && cl <= 9) || m >= cuts.V39) return cl;
  if (m < cuts.V37) return cl <= 6 ? FROM_ORIGINAL[cl] : cl;
  if (m >= cuts.V38 && FROM_V38_REMAP[cl]) return FROM_V38_REMAP[cl];
  return FROM_V37_SCALE[cl];
}

export function remapColors(outline, cuts = { V37, V38, V39 }) {
  let moved = 0;
  for (const n of Object.values(outline.nodes)) {
    const cl = newColor(n.cl, n.m, cuts);
    if (cl === n.cl) continue;
    outline.update(n.id, { cl });
    // Past the cutoff even if this device's clock runs slow.
    n.m = Math.max(n.m, cuts.V39 + 1);
    moved++;
  }
  return moved;
}
