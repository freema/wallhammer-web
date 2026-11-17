// Sun position in the sky from place, date and hour. Common formulas are enough (declination and equation of time
// from a Fourier series), a fraction-of-a-degree accuracy is more than enough for shadows.

import { DEG } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';

export interface SunSite {
  /** Latitude, positive north. */
  latitudeDeg: number;
  /** Longitude, positive east. */
  longitudeDeg: number;
  /** Day of year, 1 = 1 January. The summer solstice is around 172, the equinoxes 80 and 266. */
  dayOfYear: number;
  /** Civil time offset from UTC in hours (Central European summer time: 2). */
  utcOffsetHours: number;
}

export interface SunPosition {
  /** Azimuth from north clockwise, in degrees. 180 = due south. */
  azimuthDeg: number;
  /** Height above the horizon in degrees, negative below the horizon. */
  elevationDeg: number;
}

/** Where the sun is at a given hour of civil time (0–24). */
export function sunPosition(site: SunSite, hour: number): SunPosition {
  const g = ((2 * Math.PI) / 365) * (site.dayOfYear - 1 + (hour - 12) / 24);
  const eqTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const solarMin = hour * 60 + eqTimeMin + 4 * site.longitudeDeg - 60 * site.utcOffsetHours;
  const hourAngle = (solarMin / 4 - 180) * DEG;
  const lat = site.latitudeDeg * DEG;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinEl)));
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
  return { azimuthDeg: (((azimuth / DEG) % 360) + 360) % 360, elevationDeg: elevation / DEG };
}

/** Unit direction toward the light in the world, where x points east, y up and z south. */
export function skyDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/**
 * Unit direction to the sun in the axes of a sphere that turns about +y (its north) once a day, at an hour of
 * universal time: the sun stands straight over the latitude of its declination and over a longitude that moves a full
 * turn against the sphere's spin in 24 hours. Longitude 0 points along +x and grows toward +z, so a place at latitude
 * φ and longitude λ has the up [cos φ cos λ, sin φ, cos φ sin λ]. With that place as a `SunSite` (offset 0),
 * `sunPosition` gives the same height of the sun as this direction does against that up.
 */
export function sphereSunDirection(dayOfYear: number, utcHour: number): Vec3 {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHour - 12) / 24);
  const eqTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  // Longitude where the solar time is noon.
  const lon = ((720 - utcHour * 60 - eqTimeMin) / 4) * DEG;
  return [Math.cos(decl) * Math.cos(lon), Math.sin(decl), Math.cos(decl) * Math.sin(lon)];
}

/** Day of year from month (1–12) and day of month, for a non-leap year. */
export function dayOfYear(month: number, day: number): number {
  const before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return (before[Math.min(12, Math.max(1, Math.round(month))) - 1] ?? 0) + day;
}
