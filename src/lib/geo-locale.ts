/**
 * Small, deliberately boring mapping from ISO country code to the locale a
 * real user in that country would most likely run. Timezone is taken from the
 * geo provider when it returns a valid IANA name; the fallback table is only
 * used when the provider omits it.
 */
const TABLE: Record<string, { locale: string; timezone: string }> = {
  US: { locale: "en-US", timezone: "America/New_York" },
  CA: { locale: "en-CA", timezone: "America/Toronto" },
  MX: { locale: "es-MX", timezone: "America/Mexico_City" },
  BR: { locale: "pt-BR", timezone: "America/Sao_Paulo" },
  AR: { locale: "es-AR", timezone: "America/Argentina/Buenos_Aires" },
  CL: { locale: "es-CL", timezone: "America/Santiago" },
  CO: { locale: "es-CO", timezone: "America/Bogota" },
  PE: { locale: "es-PE", timezone: "America/Lima" },
  GB: { locale: "en-GB", timezone: "Europe/London" },
  IE: { locale: "en-IE", timezone: "Europe/Dublin" },
  DE: { locale: "de-DE", timezone: "Europe/Berlin" },
  AT: { locale: "de-AT", timezone: "Europe/Vienna" },
  CH: { locale: "de-CH", timezone: "Europe/Zurich" },
  FR: { locale: "fr-FR", timezone: "Europe/Paris" },
  BE: { locale: "nl-BE", timezone: "Europe/Brussels" },
  NL: { locale: "nl-NL", timezone: "Europe/Amsterdam" },
  LU: { locale: "fr-LU", timezone: "Europe/Luxembourg" },
  ES: { locale: "es-ES", timezone: "Europe/Madrid" },
  PT: { locale: "pt-PT", timezone: "Europe/Lisbon" },
  IT: { locale: "it-IT", timezone: "Europe/Rome" },
  GR: { locale: "el-GR", timezone: "Europe/Athens" },
  PL: { locale: "pl-PL", timezone: "Europe/Warsaw" },
  CZ: { locale: "cs-CZ", timezone: "Europe/Prague" },
  SK: { locale: "sk-SK", timezone: "Europe/Bratislava" },
  HU: { locale: "hu-HU", timezone: "Europe/Budapest" },
  RO: { locale: "ro-RO", timezone: "Europe/Bucharest" },
  BG: { locale: "bg-BG", timezone: "Europe/Sofia" },
  HR: { locale: "hr-HR", timezone: "Europe/Zagreb" },
  SI: { locale: "sl-SI", timezone: "Europe/Ljubljana" },
  RS: { locale: "sr-RS", timezone: "Europe/Belgrade" },
  UA: { locale: "uk-UA", timezone: "Europe/Kyiv" },
  RU: { locale: "ru-RU", timezone: "Europe/Moscow" },
  TR: { locale: "tr-TR", timezone: "Europe/Istanbul" },
  SE: { locale: "sv-SE", timezone: "Europe/Stockholm" },
  NO: { locale: "nb-NO", timezone: "Europe/Oslo" },
  DK: { locale: "da-DK", timezone: "Europe/Copenhagen" },
  FI: { locale: "fi-FI", timezone: "Europe/Helsinki" },
  IS: { locale: "is-IS", timezone: "Atlantic/Reykjavik" },
  EE: { locale: "et-EE", timezone: "Europe/Tallinn" },
  LV: { locale: "lv-LV", timezone: "Europe/Riga" },
  LT: { locale: "lt-LT", timezone: "Europe/Vilnius" },
  AE: { locale: "en-AE", timezone: "Asia/Dubai" },
  SA: { locale: "ar-SA", timezone: "Asia/Riyadh" },
  IL: { locale: "he-IL", timezone: "Asia/Jerusalem" },
  EG: { locale: "ar-EG", timezone: "Africa/Cairo" },
  ZA: { locale: "en-ZA", timezone: "Africa/Johannesburg" },
  NG: { locale: "en-NG", timezone: "Africa/Lagos" },
  KE: { locale: "en-KE", timezone: "Africa/Nairobi" },
  MA: { locale: "fr-MA", timezone: "Africa/Casablanca" },
  IN: { locale: "en-IN", timezone: "Asia/Kolkata" },
  PK: { locale: "en-PK", timezone: "Asia/Karachi" },
  BD: { locale: "bn-BD", timezone: "Asia/Dhaka" },
  LK: { locale: "si-LK", timezone: "Asia/Colombo" },
  NP: { locale: "ne-NP", timezone: "Asia/Kathmandu" },
  TH: { locale: "th-TH", timezone: "Asia/Bangkok" },
  VN: { locale: "vi-VN", timezone: "Asia/Ho_Chi_Minh" },
  ID: { locale: "id-ID", timezone: "Asia/Jakarta" },
  MY: { locale: "ms-MY", timezone: "Asia/Kuala_Lumpur" },
  SG: { locale: "en-SG", timezone: "Asia/Singapore" },
  PH: { locale: "en-PH", timezone: "Asia/Manila" },
  HK: { locale: "zh-HK", timezone: "Asia/Hong_Kong" },
  TW: { locale: "zh-TW", timezone: "Asia/Taipei" },
  CN: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  JP: { locale: "ja-JP", timezone: "Asia/Tokyo" },
  KR: { locale: "ko-KR", timezone: "Asia/Seoul" },
  AU: { locale: "en-AU", timezone: "Australia/Sydney" },
  NZ: { locale: "en-NZ", timezone: "Pacific/Auckland" },
};

export function localeForCountry(countryCode?: string): string | undefined {
  if (!countryCode) return undefined;
  return TABLE[countryCode.toUpperCase()]?.locale;
}

export function timezoneForCountry(countryCode?: string): string | undefined {
  if (!countryCode) return undefined;
  return TABLE[countryCode.toUpperCase()]?.timezone;
}

/** True when the string looks like an IANA zone we can hand to Playwright. */
export function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chrome reports canonical ICU names (`Asia/Saigon`, not `Asia/Ho_Chi_Minh`).
 * Storing the canonical form keeps the profile metadata identical to what a
 * page will read back from Intl.
 */
export function canonicalTimezone(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone || tz;
  } catch {
    return tz;
  }
}

export function languageList(locale: string): string[] {
  const [base] = locale.split("-");
  if (!base || base === locale) return [locale];
  return [locale, base];
}
