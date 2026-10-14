/** Formats decimal feet as feet-inches, e.g. 9.5 → 9'6", 12 → 12'. */
export function formatFeet(ft: number): string {
  const sign = ft < 0 ? '-' : '';
  const totalIn = Math.round(Math.abs(ft) * 12);
  const f = Math.floor(totalIn / 12);
  const i = totalIn % 12;
  return i === 0 ? `${sign}${f}'` : `${sign}${f}'${i}"`;
}

/** Formats a pitch as rise/12, e.g. 4 → 4/12, 2.5 → 2.5/12. */
export function formatPitch(pitch: number): string {
  return `${Number.isInteger(pitch) ? pitch : pitch.toFixed(1)}/12`;
}
