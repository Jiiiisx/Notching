/**
 * Offline prayer-time calculations (Indonesian Ministry of Religious Affairs / Kemenag standards).
 * - Fajr: 20°
 * - Isha: 18°
 * - Asr: Standard (Shafi'i, Maliki, Hanbali — shadow factor 1)
 * - Maghrib: Sun 0.8333° below horizon + dip
 * - Dhuhr: Midday + 2 min
 * - Ihtiyati (safety buffer): +2 minutes on every prayer except Sunrise (-2 min)
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
  timezone: number; // UTC offset in hours, e.g. 7 for WIB
}

export type PrayerName = "subuh" | "terbit" | "dzuhur" | "ashar" | "maghrib" | "isya";

export interface PrayerTimes {
  date: string; // YYYY-MM-DD
  subuh: string; // HH:mm
  terbit: string;
  dzuhur: string;
  ashar: string;
  maghrib: string;
  isya: string;
}

export interface NextPrayerInfo {
  name: PrayerName;
  label: string;
  time: string; // HH:mm
  targetDate: Date;
  diffMinutes: number; // positive = future
  isTenMinuteWarning: boolean; // within 10 minutes of azan
}

export const PRAYER_LABELS: Record<PrayerName, string> = {
  subuh: "Subuh",
  terbit: "Terbit",
  dzuhur: "Dzuhur",
  ashar: "Ashar",
  maghrib: "Maghrib",
  isya: "Isya",
};

// Common Indonesian cities preset
export const CITY_PRESETS: Array<{ name: string; coords: Coordinates }> = [
  { name: "Jakarta / Jabodetabek", coords: { latitude: -6.2088, longitude: 106.8456, timezone: 7 } },
  { name: "Bandung", coords: { latitude: -6.9175, longitude: 107.6191, timezone: 7 } },
  { name: "Surabaya", coords: { latitude: -7.2575, longitude: 112.7521, timezone: 7 } },
  { name: "Yogyakarta", coords: { latitude: -7.7956, longitude: 110.3695, timezone: 7 } },
  { name: "Semarang", coords: { latitude: -6.9667, longitude: 110.4167, timezone: 7 } },
  { name: "Medan", coords: { latitude: 3.5952, longitude: 98.6722, timezone: 7 } },
  { name: "Makassar", coords: { latitude: -5.1477, longitude: 119.4327, timezone: 8 } },
  { name: "Denpasar", coords: { latitude: -8.6705, longitude: 115.2126, timezone: 8 } },
  { name: "Jayapura", coords: { latitude: -2.5916, longitude: 140.669, timezone: 9 } },
];

export const DEFAULT_COORDS: Coordinates = CITY_PRESETS[0].coords;

const d2r = (d: number) => (d * Math.PI) / 180;
const r2d = (r: number) => (r * 180) / Math.PI;

function julianDay(year: number, month: number, day: number): number {
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return (
    Math.floor(365.25 * (year + 4716)) +
    Math.floor(30.6001 * (month + 1)) +
    day +
    B -
    1524.5
  );
}

function sunPosition(jd: number) {
  const D = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * D) % 360;
  const q = (280.459 + 0.98564736 * D) % 360;
  const L = (q + 1.915 * Math.sin(d2r(g)) + 0.02 * Math.sin(d2r(2 * g))) % 360;
  const e = 23.439 - 0.00000036 * D;
  const ra = r2d(Math.atan2(Math.cos(d2r(e)) * Math.sin(d2r(L)), Math.cos(d2r(L)))) / 15;
  const dec = r2d(Math.asin(Math.sin(d2r(e)) * Math.sin(d2r(L))));
  const eqt = q / 15 - (ra < 0 ? ra + 24 : ra);
  return { declination: dec, equationOfTime: eqt };
}

function hourAngle(altitude: number, lat: number, dec: number): number {
  const cosH =
    (Math.sin(d2r(altitude)) - Math.sin(d2r(lat)) * Math.sin(d2r(dec))) /
    (Math.cos(d2r(lat)) * Math.cos(d2r(dec)));
  if (cosH > 1 || cosH < -1) return 0;
  return r2d(Math.acos(cosH)) / 15;
}

function formatHours(h: number): string {
  const norm = ((h % 24) + 24) % 24;
  const hours = Math.floor(norm);
  const minutes = Math.floor((norm - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function computePrayers(date: Date, coords: Coordinates): PrayerTimes {
  const jd = julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const { declination: dec, equationOfTime: eqt } = sunPosition(jd);

  // Solar noon
  const noon = 12 + coords.timezone - coords.longitude / 15 - eqt;

  // Fajr: 20° below horizon
  const fajrAngle = hourAngle(-20, coords.latitude, dec);
  // Sunrise: 0.8333° below horizon
  const sunriseAngle = hourAngle(-0.8333, coords.latitude, dec);
  // Asr: shadow factor = 1 + tan(|lat - dec|)
  const asrAlt = r2d(
    Math.atan(1 / (1 + Math.tan(d2r(Math.abs(coords.latitude - dec)))))
  );
  const asrAngle = hourAngle(asrAlt, coords.latitude, dec);
  // Sunset: 0.8333° below horizon
  const sunsetAngle = sunriseAngle;
  // Isha: 18° below horizon
  const ishaAngle = hourAngle(-18, coords.latitude, dec);

  // Raw hours
  const rawSubuh = noon - fajrAngle;
  const rawTerbit = noon - sunriseAngle;
  const rawDzuhur = noon;
  const rawAshar = noon + asrAngle;
  const rawMaghrib = noon + sunsetAngle;
  const rawIsya = noon + ishaAngle;

  // Kemenag standard: +2 min ihtiyati on prayer times, -2 min on sunrise
  const buffer = 2 / 60;
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  return {
    date: dateStr,
    subuh: formatHours(rawSubuh + buffer),
    terbit: formatHours(rawTerbit - buffer),
    dzuhur: formatHours(rawDzuhur + buffer),
    ashar: formatHours(rawAshar + buffer),
    maghrib: formatHours(rawMaghrib + buffer),
    isya: formatHours(rawIsya + buffer),
  };
}

function parseTimeToDate(base: Date, timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Returns the upcoming prayer (excluding sunrise, which is not a prayer).
 * If all of today's prayers have passed, falls back to tomorrow's Subuh.
 */
export function getNextPrayer(now: Date, coords: Coordinates): NextPrayerInfo {
  const today = computePrayers(now, coords);
  const prayerKeys: PrayerName[] = ["subuh", "dzuhur", "ashar", "maghrib", "isya"];

  for (const k of prayerKeys) {
    const target = parseTimeToDate(now, today[k]);
    const diffMs = target.getTime() - now.getTime();
    if (diffMs > 0) {
      const diffMinutes = Math.ceil(diffMs / 60000);
      return {
        name: k,
        label: PRAYER_LABELS[k],
        time: today[k],
        targetDate: target,
        diffMinutes,
        isTenMinuteWarning: diffMinutes > 0 && diffMinutes <= 10,
      };
    }
  }

  // All prayers today have passed -> tomorrow's Subuh
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowPrayers = computePrayers(tomorrow, coords);
  const target = parseTimeToDate(tomorrow, tomorrowPrayers.subuh);
  const diffMinutes = Math.ceil((target.getTime() - now.getTime()) / 60000);
  return {
    name: "subuh",
    label: PRAYER_LABELS.subuh,
    time: tomorrowPrayers.subuh,
    targetDate: target,
    diffMinutes,
    isTenMinuteWarning: diffMinutes > 0 && diffMinutes <= 10,
  };
}
