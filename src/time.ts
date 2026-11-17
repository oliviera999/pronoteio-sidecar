/**
 * Wall-clock times of Pronote and their conversion to timestamps.
 *
 * Pronote sends and expects wall-clock times ("12/11/2026 17:10:00"), with no time zone. Until 0.8.0 the sidecar
 * read them in the time zone of the HOST (new Date(y, m, d, h, i)), so that on a host in metropolitan France (UTC+1 in
 * November), or with a time zone database older than Morocco's return to GMT on 20/09/2026, a lesson at 17:10 in
 * Casablanca came out at 16:10 in Moodle (constat du 11 au 17/11/2026).
 *
 * Since 0.9.0:
 * - the process runs in UTC (process.env.TZ = "UTC", set when this module is loaded, first import of server.ts): a
 *   "wall Date" is a Date whose local fields (getFullYear, getHours...) are the wall-clock time shown by Pronote, and
 *   no host time zone, no daylight saving gap of the host can shift it anymore;
 * - wallToEpoch / epochToWall convert between a wall Date and a real timestamp in the school's time zone
 *   (PRONOTEIO_TIMEZONE, default Africa/Casablanca), with the newest time zone database available: Node's own (ICU)
 *   when it is up to date, else the embedded "tzdata" package (IANA database as JSON, read by timezonecomplete);
 * - localString gives the wall-clock time itself ("2026-11-12 17:10"), with no conversion at all: the "local" fields
 *   of the answers, that local_pronoteio converts with Moodle's own (up to date) time zone database.
 * No offset is written in this code: every offset comes from a time zone database (test/time.test.ts checks it).
 */
import { createRequire } from "node:module";

/** Time zone of the host before the sidecar switched the process to UTC (kept for the legacy ids, see legacySeconds). */
export const HOST_TIMEZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** TZ variable of the host, as given (health check). */
export const HOST_TZ_ENV: string | null = process.env.TZ ?? null;

process.env.TZ = "UTC";

/** Time zone of the school: PRONOTEIO_TIMEZONE, default Africa/Casablanca (lycée Lyautey). */
export const SCHOOL_TIMEZONE: string = (process.env.PRONOTEIO_TIMEZONE ?? "").trim() || "Africa/Casablanca";

type Source = "node" | "tzdata";

type Engine = {
  source: Source;
  version: string;
  /** Offset of the zone at a timestamp, in minutes east of UTC (Casablanca in November 2026: 0). */
  offset: (epochMs: number, zone: string) => number;
};

const require = createRequire(import.meta.url);

/** Version of a tz database ("2026f") as a comparable number, 0 when unknown. */
export const tzVersionRank = (version: string | undefined | null): number => {
  const match = /^(\d{4})([a-z]?)$/.exec(String(version ?? "").trim());
  if (!match) return 0;
  return Number(match[1]) * 100 + (match[2] ? match[2].charCodeAt(0) - 96 : 0);
};

const intlFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset given by Node's ICU database (Intl). */
const intlOffset = (epochMs: number, zone: string): number => {
  let format = intlFormatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    intlFormatters.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
};

const nodeEngine: Engine = { source: "node", version: process.versions.tz ?? "", offset: intlOffset };

let embedded: Engine | null | undefined;

/** Engine of the embedded "tzdata" package, loaded on first use; null when it cannot be loaded. */
const embeddedEngine = (): Engine | null => {
  if (embedded !== undefined) return embedded;
  try {
    const data = require("tzdata") as { version?: string };
    const tc = require("timezonecomplete") as typeof import("timezonecomplete");
    tc.TzDatabase.init([data]);
    const zones = new Map<string, import("timezonecomplete").TimeZone>();
    embedded = {
      source: "tzdata",
      version: String(data.version ?? ""),
      offset: (epochMs, zone) => {
        let tz = zones.get(zone);
        if (!tz) {
          tz = tc.zone(zone);
          zones.set(zone, tz);
        }
        const date = new Date(epochMs);
        return tz.offsetForUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(),
          date.getUTCMinutes(), date.getUTCSeconds(), 0);
      },
    };
  } catch {
    embedded = null;
  }
  return embedded;
};

/**
 * Engine used: PRONOTEIO_TZ_SOURCE=node|tzdata forces one, "auto" (default) takes the newest database (Node's when
 * equal, it is faster).
 */
const chooseEngine = (): Engine => {
  const wanted = (process.env.PRONOTEIO_TZ_SOURCE ?? "auto").trim().toLowerCase();
  if (wanted === "node") return nodeEngine;
  const other = embeddedEngine();
  if (!other) return nodeEngine;
  if (wanted === "tzdata") return other;
  return tzVersionRank(other.version) > tzVersionRank(nodeEngine.version) ? other : nodeEngine;
};

let engine: Engine = chooseEngine();

/** For tests: choose the engine again after changing PRONOTEIO_TZ_SOURCE. */
export const resetTimeEngine = (): void => {
  engine = chooseEngine();
};

/** Offset of the school's zone at a timestamp (minutes east of UTC). */
export const zoneOffset = (epochMs: number, zone = SCHOOL_TIMEZONE): number => engine.offset(epochMs, zone);

/** Wall-clock fields of a wall Date as if they were UTC (milliseconds). */
const wallMs = (wall: Date): number =>
  Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes(), wall.getSeconds(),
    wall.getMilliseconds());

/** Real instant (ms) of a wall-clock time in a zone, with a given offset function. */
const instantOf = (wallUtcMs: number, zone: string, offset: (epochMs: number, zone: string) => number): number => {
  // Two passes: the offset at the guessed instant, then at the corrected one (exact outside the transition hours).
  const first = wallUtcMs - offset(wallUtcMs, zone) * 60_000;
  return wallUtcMs - offset(first, zone) * 60_000;
};

/** Timestamp (seconds) of a wall Date read in the school's zone. */
export const wallToEpoch = (wall: Date, zone = SCHOOL_TIMEZONE): number =>
  Math.floor(instantOf(wallMs(wall), zone, engine.offset) / 1000);

/** Wall Date (local fields = wall-clock time in the school's zone) of a timestamp in seconds. */
export const epochToWall = (epochSeconds: number, zone = SCHOOL_TIMEZONE): Date => {
  const ms = epochSeconds * 1000;
  const shifted = new Date(ms + engine.offset(ms, zone) * 60_000);
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(),
    shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds());
};

/** Current wall-clock time in the school's zone. */
export const wallNow = (): Date => epochToWall(Date.now() / 1000);

/**
 * Timestamp of a wall Date as the sidecar computed it until 0.8.0 (wall time read in the HOST's zone, with Node's
 * database). Only used inside ids that must not change (competency ids carry a timestamp).
 */
export const legacySeconds = (wall: Date): number => Math.floor(instantOf(wallMs(wall), HOST_TIMEZONE, intlOffset) / 1000);

const pad = (value: number): string => String(value).padStart(2, "0");

/** Wall-clock time of a wall Date, exactly as Pronote shows it: "2026-11-12 17:10". */
export const localString = (wall: Date): string =>
  `${wall.getFullYear()}-${pad(wall.getMonth() + 1)}-${pad(wall.getDate())} ${pad(wall.getHours())}:${pad(wall.getMinutes())}`;

/** Pattern of a wall-clock time accepted in requests: "2026-11-12 17:10", "2026-11-12T17:10[:00]" or "2026-11-12". */
export const LOCAL_PATTERN = "^\\d{4}-\\d{2}-\\d{2}([ T]\\d{2}:\\d{2}(:\\d{2})?)?$";

/** Wall Date of a wall-clock time given by Moodle ("2026-11-12 17:10"), null when malformed. */
export const parseLocal = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, h = "0", i = "0", s = "0"] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(i), Number(s));
  return date.getMonth() === Number(m) - 1 && date.getDate() === Number(d) ? date : null;
};

/**
 * Timestamp of a write input: the wall-clock time ("local") when given, preferred, else the timestamp sent. Returns
 * undefined when neither is given (and null when the timestamp is explicitly null).
 */
export const inputSeconds = (epoch: number | null | undefined, local: unknown): number | null | undefined => {
  const wall = parseLocal(local);
  if (wall) return wallToEpoch(wall);
  return epoch;
};

/** Information on the time zone handling (health check). */
export const timeInfo = (now = Date.now()) => {
  const other = embeddedEngine();
  return {
    timezone: SCHOOL_TIMEZONE,
    offsetMinutes: zoneOffset(now),
    source: engine.source,
    tzVersion: engine.version,
    nodeTzVersion: nodeEngine.version || null,
    embeddedTzVersion: other?.version ?? null,
    /** Node's database is older than the embedded one: the embedded one is used (unless forced). */
    nodeTzOutdated: other ? tzVersionRank(other.version) > tzVersionRank(nodeEngine.version) : false,
    icu: process.versions.icu ?? null,
    hostTimezone: HOST_TIMEZONE,
    hostTzEnv: HOST_TZ_ENV,
    localNow: localString(epochToWall(now / 1000)),
  };
};
