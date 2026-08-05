/**
 * Timezone-aware wall-clock helpers. The capture file name and the "HH:MM"
 * stamp on each line both use whatever IANA zone is configured
 * (`CAPTURE_TZ`, default UTC) — see `zonedParts`.
 */

export const DEFAULT_TIMEZONE = 'UTC';

// date -> { y, m, d, hh, mm } in the given IANA timezone. Defaults to UTC so
// a fresh deploy with no CAPTURE_TZ set behaves predictably everywhere.
export function zonedParts(date, timeZone = DEFAULT_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // en-US + hour12:false can render midnight as "24" instead of "00" — normalize.
  const hour = map.hour === '24' ? '00' : map.hour;
  return { y: map.year, m: map.month, d: map.day, hh: hour, mm: map.minute };
}
