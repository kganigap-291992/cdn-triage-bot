// lib/triage/resolveNamedTimeWindow.ts

export const NAMED_TIME_TIMEZONE = "America/New_York" as const;

export type NamedTimeKey =
  | "yesterday_evening"
  | "last_night"
  | "overnight"
  | "this_morning"
  | "this_afternoon"
  | "tonight"
  | "yesterday"
  | "today"
  | "right_now"
  | "now";

export type NamedTimeMatch = {
  key: NamedTimeKey;
  label: string;
  matchedText: string;
};

export type ResolvedNamedTimeWindow = {
  ok: true;
  key: NamedTimeKey;
  label: string;
  matchedText: string;
  timezone: typeof NAMED_TIME_TIMEZONE;
  timeMode: "absolute";
  source: "named_time";
  startLocalIso: string;
  endLocalIso: string;
  startUtcIso: string;
  endUtcIso: string;
  debug: {
    localNowIso: string;
    utcNowIso: string;
  };
};

export type NamedTimeResolveErrorCode =
  | "TIME_NOT_STARTED"
  | "INVALID_WINDOW"
  | "UNSUPPORTED_PHRASE";

export type NamedTimeResolveError = {
  ok: false;
  code: NamedTimeResolveErrorCode;
  phrase: string;
  message: string;
  timezone: typeof NAMED_TIME_TIMEZONE;
  debug?: {
    localNowIso: string;
    utcNowIso: string;
  };
};

export type NamedTimeResolveResult =
  | ResolvedNamedTimeWindow
  | NamedTimeResolveError;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const PHRASE_DEFS: Array<{
  key: NamedTimeKey;
  label: string;
  patterns: RegExp[];
}> = [
  {
    key: "yesterday_evening",
    label: "yesterday evening",
    patterns: [/\byesterday evening\b/i],
  },
  {
    key: "last_night",
    label: "last night",
    patterns: [/\blast night\b/i],
  },
  {
    key: "overnight",
    label: "overnight",
    patterns: [/\bovernight\b/i],
  },
  {
    key: "this_morning",
    label: "this morning",
    patterns: [/\bthis morning\b/i],
  },
  {
    key: "this_afternoon",
    label: "this afternoon",
    patterns: [/\bthis afternoon\b/i],
  },
  {
    key: "tonight",
    label: "tonight",
    patterns: [/\btonight\b/i],
  },
  {
    key: "yesterday",
    label: "yesterday",
    patterns: [/\byesterday\b/i],
  },
  {
    key: "today",
    label: "today",
    patterns: [/\btoday\b/i],
  },
  {
    key: "right_now",
    label: "right now",
    patterns: [/\bright now\b/i],
  },
  {
    key: "now",
    label: "now",
    patterns: [/\bnow\b/i],
  },
];

export function parseNamedTimePhrase(input: string): NamedTimeMatch | null {
  const text = (input || "").trim();
  if (!text) return null;

  for (const def of PHRASE_DEFS) {
    for (const pattern of def.patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          key: def.key,
          label: def.label,
          matchedText: match[0],
        };
      }
    }
  }

  return null;
}

export function resolveNamedTimeWindow(args: {
  key: NamedTimeKey;
  label?: string;
  matchedText?: string;
  now?: Date;
}): NamedTimeResolveResult {
  const now = args.now ?? new Date();
  const key = args.key;
  const label = args.label ?? defaultLabelForKey(key);
  const matchedText = args.matchedText ?? label;

  const localNow = getLocalParts(now, NAMED_TIME_TIMEZONE);
  const localNowIso = formatLocalIso(localNow);
  const utcNowIso = now.toISOString();

  const todayStart: LocalParts = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
    hour: 0,
    minute: 0,
    second: 0,
  };

  const tomorrowStart = addDaysLocal(todayStart, 1);
  const yesterdayStart = addDaysLocal(todayStart, -1);

  let startLocal: LocalParts;
  let endLocal: LocalParts;

  switch (key) {
    case "last_night": {
      startLocal = setLocalTime(yesterdayStart, 20, 0, 0);
      endLocal = setLocalTime(todayStart, 6, 0, 0);
      break;
    }

    case "overnight": {
      startLocal = setLocalTime(yesterdayStart, 22, 0, 0);
      endLocal = setLocalTime(todayStart, 6, 0, 0);
      break;
    }

    case "today": {
      startLocal = todayStart;
      endLocal = localNow;
      break;
    }

    case "this_morning": {
      startLocal = setLocalTime(todayStart, 6, 0, 0);
      endLocal = minLocalParts(localNow, setLocalTime(todayStart, 12, 0, 0));
      break;
    }

    case "this_afternoon": {
      startLocal = setLocalTime(todayStart, 12, 0, 0);
      endLocal = minLocalParts(localNow, setLocalTime(todayStart, 18, 0, 0));
      break;
    }

    case "tonight": {
      if (localNow.hour < 18) {
        return {
          ok: false,
          code: "TIME_NOT_STARTED",
          phrase: matchedText,
          message: `"Tonight" has not started yet in ${NAMED_TIME_TIMEZONE}.`,
          timezone: NAMED_TIME_TIMEZONE,
          debug: {
            localNowIso,
            utcNowIso,
          },
        };
      }

      startLocal = setLocalTime(todayStart, 18, 0, 0);
      endLocal = localNow;
      break;
    }

    case "yesterday": {
      startLocal = yesterdayStart;
      endLocal = todayStart;
      break;
    }

    case "yesterday_evening": {
      startLocal = setLocalTime(yesterdayStart, 18, 0, 0);
      endLocal = todayStart;
      break;
    }

    case "right_now":
    case "now": {
      const startMs = now.getTime() - 30 * 60 * 1000;
      const startDate = new Date(startMs);
      startLocal = getLocalParts(startDate, NAMED_TIME_TIMEZONE);
      endLocal = localNow;
      break;
    }

    default: {
      return {
        ok: false,
        code: "UNSUPPORTED_PHRASE",
        phrase: matchedText,
        message: `Unsupported named time phrase: "${matchedText}".`,
        timezone: NAMED_TIME_TIMEZONE,
        debug: {
          localNowIso,
          utcNowIso,
        },
      };
    }
  }

  const startUtc = zonedLocalToUtcDate(startLocal, NAMED_TIME_TIMEZONE);
  const endUtc = zonedLocalToUtcDate(endLocal, NAMED_TIME_TIMEZONE);

  if (endUtc.getTime() <= startUtc.getTime()) {
    return {
      ok: false,
      code: "INVALID_WINDOW",
      phrase: matchedText,
      message: `Resolved time window for "${matchedText}" is empty or invalid.`,
      timezone: NAMED_TIME_TIMEZONE,
      debug: {
        localNowIso,
        utcNowIso,
      },
    };
  }

  return {
    ok: true,
    key,
    label,
    matchedText,
    timezone: NAMED_TIME_TIMEZONE,
    timeMode: "absolute",
    source: "named_time",
    startLocalIso: formatLocalIso(startLocal),
    endLocalIso: formatLocalIso(endLocal),
    startUtcIso: startUtc.toISOString(),
    endUtcIso: endUtc.toISOString(),
    debug: {
      localNowIso,
      utcNowIso,
    },
  };
}

export function parseAndResolveNamedTimeWindow(
  input: string,
  now: Date = new Date(),
): NamedTimeResolveResult | null {
  const match = parseNamedTimePhrase(input);
  if (!match) return null;

  return resolveNamedTimeWindow({
    key: match.key,
    label: match.label,
    matchedText: match.matchedText,
    now,
  });
}

function defaultLabelForKey(key: NamedTimeKey): string {
  switch (key) {
    case "yesterday_evening":
      return "yesterday evening";
    case "last_night":
      return "last night";
    case "overnight":
      return "overnight";
    case "this_morning":
      return "this morning";
    case "this_afternoon":
      return "this afternoon";
    case "tonight":
      return "tonight";
    case "yesterday":
      return "yesterday";
    case "today":
      return "today";
    case "right_now":
      return "right now";
    case "now":
      return "now";
  }
}

function getLocalParts(date: Date, timeZone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(date);

  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)?.value;
    if (!part) {
      throw new Error(`Missing "${type}" when formatting date in timezone ${timeZone}`);
    }
    return Number(part);
  };

  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
    hour: lookup("hour"),
    minute: lookup("minute"),
    second: lookup("second"),
  };
}

function formatLocalIso(parts: LocalParts): string {
  return [
    pad4(parts.year),
    "-",
    pad2(parts.month),
    "-",
    pad2(parts.day),
    "T",
    pad2(parts.hour),
    ":",
    pad2(parts.minute),
    ":",
    pad2(parts.second),
  ].join("");
}

function setLocalTime(
  base: Pick<LocalParts, "year" | "month" | "day">,
  hour: number,
  minute: number,
  second: number,
): LocalParts {
  return {
    year: base.year,
    month: base.month,
    day: base.day,
    hour,
    minute,
    second,
  };
}

function addDaysLocal(parts: LocalParts, days: number): LocalParts {
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second);
  const shifted = new Date(utcMs);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function minLocalParts(a: LocalParts, b: LocalParts): LocalParts {
  return compareLocalParts(a, b) <= 0 ? a : b;
}

function compareLocalParts(a: LocalParts, b: LocalParts): number {
  const ak = [
    a.year,
    a.month,
    a.day,
    a.hour,
    a.minute,
    a.second,
  ];
  const bk = [
    b.year,
    b.month,
    b.day,
    b.hour,
    b.minute,
    b.second,
  ];

  for (let i = 0; i < ak.length; i += 1) {
    if (ak[i] < bk[i]) return -1;
    if (ak[i] > bk[i]) return 1;
  }

  return 0;
}

function zonedLocalToUtcDate(parts: LocalParts, timeZone: string): Date {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let candidate = utcGuess;

  for (let i = 0; i < 6; i += 1) {
    const candidateDate = new Date(candidate);
    const observed = getLocalParts(candidateDate, timeZone);

    const desiredAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );

    const observedAsUtcMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );

    const diffMs = desiredAsUtcMs - observedAsUtcMs;
    if (diffMs === 0) {
      return candidateDate;
    }

    candidate += diffMs;
  }

  return new Date(candidate);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}