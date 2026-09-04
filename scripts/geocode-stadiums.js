/**
 * FOOTBALLGLOBE - GEOCODING SCRIPT
 *
 * Resolves stadium coordinates from the Google Geocoding API.
 *
 * Query shape: venue + ', ' + city + ', ' + countryName
 *   stadium.address is deliberately NOT used. football-data.org's address
 *   field is the club's registered office or training ground, not the ground
 *   itself (Bayern -> Sabener Strasse, Roma -> Trigoria, Lazio -> Formello),
 *   and including it drags the result onto the offices.
 *
 * Acceptance: three tiers, cheapest first.
 *   tier 1  results[0].types contains "stadium". Free and decisive.
 *   tier 2  for anything not settled by tier 1 or 3: OpenStreetMap is asked
 *           whether it holds a leisure=stadium|pitch|sports_centre within
 *           500m of Google's point. Failing that, the older venue-name test
 *           (the venue name appears verbatim in formatted_address) still
 *           applies - it is what recovers correctly-located grounds that
 *           nobody has tagged as a stadium.
 *   tier 3  types describing only an AREA - locality, political, sublocality,
 *           administrative_area_*, neighborhood, colloquial_area, route - are
 *           the geocoder falling back to the region, and are rejected without
 *           spending an OSM request.
 *   A rejection still keeps whatever coordinates the record already had: a bad
 *   match never overwrites good data, and a rejection never nulls a record.
 *   Which tier accepted a record is written to it as acceptedTier/acceptedBy.
 *
 * OpenStreetMap: Nominatim, rate-limited to 1 request/second with an
 *   application-identifying User-Agent per its usage policy, and given an
 *   explicit per-request timeout (OSM_TIMEOUT_MS) because Node has none by
 *   default and a stalled socket at 1 request/second stalls the whole run.
 *   Responses are cached outside the repository (OSM_CACHE_DIR, default the
 *   system temp dir) so a re-run costs no OSM requests. An OSM failure is never
 *   an acceptance: it falls through to the name test, so an outage - or a
 *   timeout - cannot produce a wrong coordinate. The sidecar records osmStatus
 *   'ok' | 'empty' | 'failed', because "OSM has nothing here" and "we could not
 *   ask OSM" are different facts and only the first is about the venue.
 *
 * Sidecar evidence: every tier-2 record, ACCEPTED OR REJECTED, also carries the
 *   nearest qualifying OSM feature at any distance (osmNearest), how many were
 *   seen (osmCandidateCount), the Nominatim URL that produced the results, and
 *   Google's location_type. These are recorded, never consulted. Acceptance is
 *   still the within-radius match and nothing else, so this changes what a run
 *   REMEMBERS, not what it CHOOSES - it exists so the radius can be judged from
 *   a sidecar instead of from another billable run.
 *
 *   osmFromCache says which of those rows this run actually fetched. The OSM
 *   cache is keyed on the NORMALISED venue+country, so one entry serves every
 *   spelling of a ground, and a cache hit's recorded URL is rebuilt from the
 *   query the entry was fetched under rather than from the row's own venue -
 *   otherwise the sidecar would show a request that was never made.
 *
 * City: the query uses relaxCity(city), dropping a trailing ", <region>".
 *   Google reads an appended county/province as a request for the region -
 *   "BC Place, Vancouver, British Columbia, Canada" returns the Vancouver city
 *   centre, "BC Place, Vancouver, Canada" returns the stadium 919m away.
 *
 * city is re-derived from the accepted response. The stored city is used to
 *   build the query but is never carried into the output: a city extracted
 *   from a previously bad match would otherwise persist forever.
 *
 * Quota: OVER_QUERY_LIMIT comes back as HTTP 200, so every retry is a real
 *   billable request against the quota that just refused it. Daily exhaustion
 *   therefore aborts the run outright, and only per-second throttling is
 *   retried. MAX_REQUESTS caps the run regardless. Either stop writes the
 *   files first, so a partial run is never a lost run.
 *
 * Input: two file shapes, chosen with --input=<path> and detected from the
 *   PARSED DATA, never the filename - a file can be renamed, its contents
 *   cannot lie.
 *     nested  stadiums-premium.json (the default): countries -> leagues ->
 *             stadiums, venue name in `venue`, identity `teamId`.
 *     flat    stadiums-apifootball-candidate.json: a venues[] array, venue name
 *             in `name`, identity `venueId`, `teamIds`/`teamNames` as arrays,
 *             plus coordinateSource/carryRule/carryExcluded from the
 *             carry-forward passes.
 *   Everything between loading and writing works on a uniform view, so the
 *   geocoding loop never asks which shape it is holding. Writes go back through
 *   that view into the original record, so the output file is the same
 *   structure as the input with only the geocoder's own fields changed.
 *   The flat records carry an `address`; it is deliberately NOT used in the
 *   query, for the same reason football-data's address is not - see above.
 *
 * Overrides and id namespaces: venue-overrides.json declares the provider whose
 *   team ids it is keyed on (idSource, default football-data). An override is
 *   applied only when that matches the input shape's namespace - nested is
 *   football-data, flat is api-football - because the two providers number
 *   their clubs independently and the numbers collide: football-data's 62 is
 *   Everton, api-football's 62 is Sheffield United. A mismatch is a silent
 *   no-op, since neither file is wrong, but the total is counted and printed:
 *   an overrides file re-keyed for this input has to look different from one
 *   that has not been.
 *
 * Output: <input>-candidate by default (stadiums-premium-candidate.json for the
 *   default input, <input>.geocode-candidate.json otherwise). Pass --apply to
 *   write the input file itself for real. Every complete API response is
 *   persisted to a sidecar JSON next to the output.
 *
 * Selection: every stadium is re-queried by default. --only-missing narrows
 *   the run to records without usable coordinates; --team=<ids> narrows it to
 *   an explicit list and ignores --only-missing, so a single ground can be
 *   re-resolved even though it already has coordinates. Skipped records are
 *   not touched at all - they keep every field exactly as loaded.
 *
 * Usage: node scripts/geocode-stadiums.js [--input=<path>] [--apply]
 *          [--only-missing] [--team=<id,id>]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

// Resolved from __dirname so the script reads and writes the repo-root files
// no matter which directory it is run from.
const ROOT = path.join(__dirname, '..');

// The dedicated geocoding key, and only that key. There is deliberately no
// fallback to the browser Maps key: it is normally HTTP-referrer restricted and
// fails server-side with REQUEST_DENIED, so falling back to it converts a
// missing-variable mistake into a run that burns nothing but time and ends in
// REQUEST_DENIED on every row. The key is never printed, in whole or in part,
// and never appears in a log line, an error message or the sidecar.
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_GEOCODING_KEY;

// Rate limiting between Geocoding API calls, in ms.
const CALL_DELAY_MS = 500;

// Hard ceiling on Geocoding API requests for a single run, retries included.
// Reaching it stops the run and saves, so a runaway input file or a retry loop
// can never quietly eat the day's quota. Override for a big backfill with
// GEOCODE_MAX_REQUESTS=2000 node scripts/geocode-stadiums.js
const MAX_REQUESTS = Number(process.env.GEOCODE_MAX_REQUESTS) || 800;

// Per-second rate limiting only: total attempts per stadium (so
// RATE_LIMIT_MAX_ATTEMPTS - 1 retries), and the first backoff, doubling after.
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 2000;

// Tier 2 asks OpenStreetMap for a second opinion. Nominatim's usage policy caps
// this at 1 request/second and requires an application-identifying User-Agent;
// both are hard requirements, not tuning knobs. No personal contact details go
// in the header.
const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
const NOMINATIM_DELAY_MS = 1100;
const NOMINATIM_USER_AGENT = 'footballglobe-geocoder/1.0 (stadium coordinate verification)';

// Hard ceiling on a single Nominatim request. Node's default is no timeout at
// all, so a half-open socket would stall the whole run indefinitely - at 1
// request/second a stall is the one failure mode that costs more than the
// lookup is worth. Hitting it destroys the socket and counts as an OSM failure,
// which falls through to the name test exactly like any other failure.
const NOMINATIM_TIMEOUT_MS = Number(process.env.OSM_TIMEOUT_MS) || 10000;

// How close an OSM sport feature must sit to Google's point to corroborate it.
// 500m comfortably spans a stadium site while excluding the town-centre
// fallbacks that tier 3 is meant to catch anyway.
const OSM_MATCH_RADIUS_KM = 0.5;

// OSM responses are cached OUTSIDE the repository, keyed by venue+country, so a
// re-run costs no Nominatim requests and the cache can never be mistaken for
// project data. Override with OSM_CACHE_DIR.
const OSM_CACHE_DIR = process.env.OSM_CACHE_DIR
  || path.join(os.tmpdir(), 'footballglobe-osm-cache');

// OSM tags that corroborate a stadium. Anything else OSM returns is ignored.
const OSM_SPORT_TYPES = new Set(['stadium', 'pitch', 'sports_centre']);

/**
 * Tier 3: result types that describe an AREA rather than a place - a town, a
 * district, a street. A result carrying only these is the geocoder falling back
 * to the region because it could not find the venue, which is the single most
 * common failure mode. There is nothing for OSM to corroborate, so these are
 * rejected without spending a Nominatim request.
 */
const AREA_ONLY_TYPES = new Set([
  'locality', 'political', 'sublocality', 'sublocality_level_1',
  'sublocality_level_2', 'neighborhood', 'colloquial_area', 'route',
]);

function isAreaOnlyResult(types) {
  if (!types || types.length === 0) return false;
  return types.every(t => AREA_ONLY_TYPES.has(t) || /^administrative_area_level_\d+$/.test(t));
}

const APPLY = process.argv.includes('--apply');

// Opt-in: skip any stadium that already has usable coordinates. Off by default,
// so an unflagged run still re-queries everything and can still improve a
// record that has coordinates but poor ones.
const ONLY_MISSING = process.argv.includes('--only-missing');

/**
 * --team=<id>[,<id>...], repeatable. Restricts the run to those team IDs and
 * geocodes them whether or not they already have coordinates, which is the
 * point of the flag: re-resolving one known-bad ground without a full run.
 * Returns null when the flag is absent - null means "no restriction", which is
 * deliberately distinct from an empty set.
 */
function parseTeamFilter(argv) {
  const raw = argv
    .filter(arg => arg.startsWith('--team='))
    .flatMap(arg => arg.slice('--team='.length).split(','))
    .map(part => part.trim())
    .filter(part => part.length > 0);

  if (raw.length === 0) return null;

  const ids = new Set();
  const bad = [];
  for (const part of raw) {
    const id = Number(part);
    if (Number.isInteger(id) && id > 0) ids.add(id);
    else bad.push(part);
  }

  if (bad.length > 0) {
    console.error(`ERROR: --team got non-numeric team id(s): ${bad.join(', ')}`);
    process.exit(1);
  }
  return ids;
}

const TEAM_FILTER = parseTeamFilter(process.argv);

const DEFAULT_INPUT_PATH = path.join(ROOT, 'stadiums-premium.json');

/**
 * --input=<path>. Absent means stadiums-premium.json, so every invocation that
 * works today keeps working byte for byte. A relative path resolves against the
 * working directory rather than the repo root, because that is what a shell
 * completes and what a reader of the command line will assume.
 */
function parseInputPath(argv) {
  const arg = argv.filter(a => a.startsWith('--input=')).pop();
  if (!arg) return DEFAULT_INPUT_PATH;

  const value = arg.slice('--input='.length).trim();
  if (value.length === 0) {
    console.error('ERROR: --input= was given with no path.');
    process.exit(1);
  }
  return path.resolve(process.cwd(), value);
}

const INPUT_PATH = parseInputPath(process.argv);
const IS_DEFAULT_INPUT = INPUT_PATH === DEFAULT_INPUT_PATH;

/**
 * --apply writes back over the input, whatever the input is. A dry run writes a
 * candidate beside it. The default input keeps its historical candidate name so
 * existing commands and .gitignore entries still match it; any other input gets
 * <input>.geocode-candidate.json, which is unambiguous even when the input is
 * itself called "-candidate".
 */
const OUTPUT_PATH = APPLY
  ? INPUT_PATH
  : (IS_DEFAULT_INPUT
    ? path.join(ROOT, 'stadiums-premium-candidate.json')
    : INPUT_PATH.replace(/\.json$/, '.geocode-candidate.json'));
const RAW_PATH = OUTPUT_PATH.replace(/\.json$/, '.geocode-raw.json');

/**
 * football-data.org area codes -> ISO 3166-1 alpha-2, which is what Google's
 * components=country: filter accepts. Mostly alpha-3, but ENG/WAL are UK
 * subdivisions (-> GB) and POR is the FIFA code for Portugal (ISO-3 is PRT).
 * A code with no entry here means the request goes out unconstrained.
 */
const AREA_CODE_TO_ISO2 = {
  ENG: 'GB', WAL: 'GB', SCO: 'GB', NIR: 'GB',
  ESP: 'ES', ITA: 'IT', DEU: 'DE', FRA: 'FR', NLD: 'NL', POR: 'PT', PRT: 'PT',
  BRA: 'BR', TUR: 'TR', NOR: 'NO', MCO: 'MC', BEL: 'BE', CZE: 'CZ', UKR: 'UA',
  GRC: 'GR', AUT: 'AT', SVK: 'SK', AZE: 'AZ', CHE: 'CH', DNK: 'DK', SWE: 'SE',
  POL: 'PL', SRB: 'RS', HRV: 'HR', SCT: 'GB', IRL: 'IE',
};

/**
 * The flat shape carries a country NAME and no area code, so the components=
 * country: filter needs a name -> ISO2 map instead. These are api-football's
 * exact spellings, hyphens and all; this table is the one geocode-ab-test.js
 * used, so the flat shape asks Google the same question the A/B test validated.
 * A country with no entry here goes out unconstrained, which is a weaker query
 * but never a wrong one - and that is why "Congo" is deliberately absent, since
 * it could be CG or CD and a wrong country filter is worse than none.
 */
const COUNTRY_NAME_TO_ISO2 = {
  England: 'GB', Scotland: 'GB', Wales: 'GB', 'Northern-Ireland': 'GB',
  Spain: 'ES', Italy: 'IT', Germany: 'DE', France: 'FR', Netherlands: 'NL',
  Portugal: 'PT', Brazil: 'BR', Turkey: 'TR', Norway: 'NO', Monaco: 'MC',
  Belgium: 'BE', 'Czech-Republic': 'CZ', Ukraine: 'UA', Greece: 'GR',
  Austria: 'AT', Slovakia: 'SK', Azerbaijan: 'AZ', Switzerland: 'CH',
  Denmark: 'DK', Sweden: 'SE', Poland: 'PL', Serbia: 'RS', Croatia: 'HR',
  Ireland: 'IE', Argentina: 'AR', Mexico: 'MX', USA: 'US', Japan: 'JP',
  'South-Korea': 'KR', China: 'CN', Australia: 'AU', Russia: 'RU',
  Romania: 'RO', Bulgaria: 'BG', Hungary: 'HU', Finland: 'FI', Iceland: 'IS',
  Israel: 'IL', Egypt: 'EG', Morocco: 'MA', Tunisia: 'TN', Algeria: 'DZ',
  'South-Africa': 'ZA', Nigeria: 'NG', Ghana: 'GH', India: 'IN',
  Indonesia: 'ID', Thailand: 'TH', Vietnam: 'VN', Malaysia: 'MY',
  Colombia: 'CO', Chile: 'CL', Peru: 'PE', Uruguay: 'UY', Paraguay: 'PY',
  Ecuador: 'EC', Bolivia: 'BO', Venezuela: 'VE', Canada: 'CA',
  'Saudi-Arabia': 'SA', Qatar: 'QA', 'United-Arab-Emirates': 'AE',
  Kazakhstan: 'KZ', Georgia: 'GE', Armenia: 'AM', Belarus: 'BY',
  Lithuania: 'LT', Latvia: 'LV', Estonia: 'EE', Slovenia: 'SI',
  'Bosnia-and-Herzegovina': 'BA', Albania: 'AL', 'North-Macedonia': 'MK',
  Montenegro: 'ME', Kosovo: 'XK', Cyprus: 'CY', Malta: 'MT', Luxembourg: 'LU',
  Iran: 'IR', Iraq: 'IQ', Jordan: 'JO', Kuwait: 'KW', Oman: 'OM',
  Bahrain: 'BH', Lebanon: 'LB', Syria: 'SY', Uzbekistan: 'UZ',
  Andorra: 'AD', Angola: 'AO', Barbados: 'BB', Bangladesh: 'BD',
  Jamaica: 'JM', 'Trinidad-And-Tobago': 'TT', 'Costa-Rica': 'CR',
  Panama: 'PA', Guatemala: 'GT', Honduras: 'HN', 'El-Salvador': 'SV',
  Nicaragua: 'NI', 'Dominican-Republic': 'DO', Haiti: 'HT', Cuba: 'CU',
  Kenya: 'KE', Tanzania: 'TZ', Uganda: 'UG', Zambia: 'ZM', Zimbabwe: 'ZW',
  Cameroon: 'CM', Senegal: 'SN', 'Ivory-Coast': 'CI', Mali: 'ML',
  Ethiopia: 'ET', Sudan: 'SD', Libya: 'LY', Mozambique: 'MZ', Botswana: 'BW',
  Rwanda: 'RW', Burundi: 'BI', Gabon: 'GA', 'Congo-DR': 'CD',
  'Burkina-Faso': 'BF', Niger: 'NE', Guinea: 'GN', Benin: 'BJ', Togo: 'TG',
  Singapore: 'SG', Philippines: 'PH', Myanmar: 'MM', Cambodia: 'KH',
  Nepal: 'NP', Pakistan: 'PK', 'Sri-Lanka': 'LK',
  'New-Zealand': 'NZ', Fiji: 'FJ', 'Papua-New-Guinea': 'PG',
  Moldova: 'MD', Turkmenistan: 'TM', Kyrgyzstan: 'KG', Tajikistan: 'TJ',
  Mongolia: 'MN', Afghanistan: 'AF', Yemen: 'YE', Palestine: 'PS',
  'Faroe-Islands': 'FO', Gibraltar: 'GI', 'San-Marino': 'SM',
  Liechtenstein: 'LI', 'Hong-Kong': 'HK', Macao: 'MO',
  Bhutan: 'BT', Malawi: 'MW', Bosnia: 'BA', Macedonia: 'MK', Taiwan: 'TW',
  Bahamas: 'BS', Bermuda: 'BM', Suriname: 'SR', Guyana: 'GY',
  Lesotho: 'LS', Chad: 'TD', Brunei: 'BN', Tahiti: 'PF',
};

/**
 * Manual corrections for venues football-data.org has not updated, keyed by
 * teamId. An entry here is authoritative: the stadium is NOT geocoded at all,
 * because an override exists precisely for records the API gets wrong.
 *
 * The keys belong to ONE id namespace, declared by the file's own idSource. A
 * team id means nothing without knowing whose id it is - football-data's 62 is
 * Everton, api-football's 62 is Sheffield United - so an override is applied
 * only to records identified in the namespace it was written for. See
 * SHAPE_ID_SOURCE and resolveOverride.
 */
const {
  _comment: _venueOverridesComment,
  _idSourceComment: _venueOverridesIdSourceComment,
  // Absent means football-data: that is what every entry written so far is, and
  // the default has to match the file's history rather than be a guess.
  idSource: VENUE_OVERRIDES_ID_SOURCE = 'football-data',
  ...VENUE_OVERRIDES
} = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'venue-overrides.json'), 'utf8')
);

/**
 * Which provider's team ids each input shape carries. This is the fact that
 * makes an override safe or catastrophic: the nested file is football-data's,
 * the flat file is api-football's, and the two number their clubs
 * independently.
 */
const SHAPE_ID_SOURCE = {
  nested: 'football-data',
  flat: 'api-football',
};

/**
 * Apply a manual override onto a stadium record in place. Only the fields the
 * override actually specifies are touched; anything omitted keeps its
 * existing value. Mirrors applyVenueOverride in export-stadiums-proxy.js.
 */
function applyVenueOverride(stadium, override) {
  if (override.venue) stadium.venue = override.venue;
  if (override.address) stadium.address = override.address;
  if (override.city) stadium.city = override.city;
  if (override.latitude !== undefined && override.latitude !== null) {
    stadium.latitude = override.latitude;
  }
  if (override.longitude !== undefined && override.longitude !== null) {
    stadium.longitude = override.longitude;
  }
  if (stadium.venue && stadium.address) {
    stadium.fullAddress = `${stadium.venue}, ${stadium.address}`;
  }
}

/**
 * Which override, if any, applies to one item. The nested shape has a single
 * teamId, the flat shape a teamIds array for the several clubs that share a
 * ground, and an override keyed on any one of them is an override of that
 * ground.
 *
 * Two ids on the same record pointing at DIFFERENT overrides is unresolvable
 * from here - the two entries disagree about a single physical venue - so it
 * returns the colliding ids instead of picking one. The caller logs them and
 * geocodes the record normally, which is the outcome that cannot silently write
 * the wrong ground.
 */
function resolveOverride(item) {
  const wantedSource = SHAPE_ID_SOURCE[item.shape] || null;

  const hits = [];
  const seen = new Set();
  let mismatched = 0;

  for (const id of item.teamIds) {
    const override = VENUE_OVERRIDES[id];
    // Same entry reached twice (a duplicated id) is not a second anything.
    if (!override || seen.has(override)) continue;
    seen.add(override);

    // The namespace test comes FIRST, before the entry can count as a hit or
    // as a conflict. An override from another provider's id space is not a
    // weaker match, it is a different club: a numeric collision, and applying
    // it would write one club's correction onto another club's ground. Skipped
    // silently - there is nothing wrong with either file, they simply do not
    // address the same records - but counted, so a file that has been re-keyed
    // for this input reads differently from one that has not.
    const entrySource = override.idSource || VENUE_OVERRIDES_ID_SOURCE;
    if (entrySource !== wantedSource) {
      mismatched++;
      continue;
    }

    hits.push({ id, override });
  }

  if (hits.length === 0) {
    return { override: null, id: null, conflict: null, mismatched };
  }
  if (hits.length > 1) {
    return { override: null, id: null, conflict: hits.map(hit => hit.id), mismatched };
  }
  return { override: hits[0].override, id: hits[0].id, conflict: null, mismatched };
}

/**
 * Normalise a string for venue-name comparison: strip accents, lowercase,
 * turn punctuation into spaces, and expand the street abbreviations Google
 * returns ("Elland Rd" vs our "Elland Road"). "St" is deliberately NOT
 * expanded - it collides with Saint in club and ground names.
 */
function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\brd\b/g, 'road')
    .replace(/\bln\b/g, 'lane')
    .replace(/\bave?\b/g, 'avenue')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip a trailing ", <region>" from a city before it goes into the query.
 * Sources carry the county or province appended ("Vancouver, British Columbia",
 * "Bournemouth, Dorset"), and Google reads that as a request for the region:
 * "BC Place, Vancouver, British Columbia, Canada" returns the Vancouver city
 * centre, while "BC Place, Vancouver, Canada" returns the stadium 919m away.
 * Same normalisation as relaxCity in export-stadiums-apifootball.js.
 */
function relaxCity(value) {
  return String(value || '').split(',')[0].trim();
}

/**
 * Great-circle distance in km, for comparing Google's point to OSM's.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * Second acceptance path: the venue name appears verbatim inside the returned
 * formatted_address. Google types plenty of older grounds as route/premise/
 * sublocality rather than "stadium" (Anfield, Elland Road, Bramall Lane), but
 * it still names them. Requires the whole venue string to be present, so a
 * road merely named after the same person does not qualify.
 */
function venueNameMatches(venue, formattedAddress) {
  if (!venue || venue === 'Unknown') return false;
  const needle = normalizeForMatch(venue);
  const haystack = normalizeForMatch(formattedAddress);
  if (needle.length < 5) return false;
  return haystack.includes(needle);
}

/**
 * Extract a city name from a Geocoding API address_components array.
 * Prefers locality, then falls back to postal_town, then
 * administrative_area_level_2. Returns undefined if none match.
 */
function extractCity(addressComponents) {
  const preferredTypes = ['locality', 'postal_town', 'administrative_area_level_2'];

  for (const type of preferredTypes) {
    const component = addressComponents.find(c => c.types.includes(type));
    if (component) {
      return component.long_name;
    }
  }

  return undefined;
}

/**
 * Whether a stadium already holds coordinates worth keeping. Both values must
 * be finite numbers, and 0,0 is rejected: Null Island is what an unresolved
 * record degrades into, not a real ground.
 *
 * A stringified coordinate ("51.5") counts as NOT valid on purpose. The two
 * failure directions are not symmetric - re-geocoding a good record costs one
 * request, while wrongly skipping one leaves bad data in place forever - so
 * anything not plainly a number falls through to being geocoded.
 */
function hasValidCoordinates(stadium) {
  const { latitude, longitude } = stadium;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

/**
 * Build the query as venue + ', ' + city + ', ' + countryName, skipping any
 * segment that is absent or the literal placeholder "Unknown".
 */
function buildAddress(stadium, countryName) {
  const missing = [];
  const parts = [];

  if (stadium.venue && stadium.venue !== 'Unknown') parts.push(stadium.venue);
  else missing.push('venue');

  // relaxCity, not the raw value: a trailing region drags the result onto the
  // region. See relaxCity above.
  if (stadium.city) parts.push(relaxCity(stadium.city));
  else missing.push('city');

  if (countryName) parts.push(countryName);
  else missing.push('country');

  return { address: parts.join(', '), missing };
}

/**
 * Signals that the run must stop now and save what it has. Distinct from an
 * ordinary fetch error, which only costs the one stadium: this one propagates
 * out of the stadium loop and ends the run.
 */
class RunAborted extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RunAborted';
    this.reason = reason;
  }
}

// Every request this run has actually put on the wire, retries included.
let requestCount = 0;

/**
 * Geocode an address. Resolves the COMPLETE parsed response so the caller can
 * inspect types/address_components and persist the payload verbatim.
 *
 * Counts against MAX_REQUESTS, and throws RunAborted rather than issuing the
 * request that would exceed it - the ceiling is checked here, at the single
 * place a request is made, so retries cannot slip past it.
 */
function geocodeAddress(address, iso2) {
  if (requestCount >= MAX_REQUESTS) {
    throw new RunAborted('request-ceiling',
      `request ceiling of ${MAX_REQUESTS} reached`);
  }
  requestCount++;

  return new Promise((resolve, reject) => {
    let url = 'https://maps.googleapis.com/maps/api/geocode/json'
      + `?address=${encodeURIComponent(address)}`;
    if (iso2) {
      url += `&components=${encodeURIComponent('country:' + iso2)}`;
    }
    url += `&key=${GOOGLE_API_KEY}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Sleep for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * OVER_QUERY_LIMIT arrives with HTTP 200, so a retry is a fresh billable
 * request against the very quota that just refused it. Two opposite situations
 * hide behind that one status, and error_message is what separates them:
 *
 *   daily cap  - "You have exceeded your daily request quota for this API."
 *                No retry can succeed before midnight Pacific, and each one
 *                still counts, so this ends the run.
 *   per-second - "You have exceeded your rate-limit for this API." Transient,
 *                and the only case worth a backoff.
 *
 * OVER_DAILY_LIMIT is always fatal - exhausted quota, or a key/billing problem
 * that waiting does not fix.
 */
function isDailyQuotaExhausted(response) {
  if (response.status === 'OVER_DAILY_LIMIT') return true;
  if (response.status !== 'OVER_QUERY_LIMIT') return false;
  return /daily|per day|billing|budget/i.test(response.error_message || '');
}

/**
 * True only for the short-term throttle. An OVER_QUERY_LIMIT with no
 * error_message counts as one: that is how the QPS limiter has historically
 * presented, and it is the only ambiguous case left once the daily wording is
 * ruled out. An OVER_QUERY_LIMIT whose message matches neither is left alone -
 * not retried, not fatal, just handed back as an ordinary rejection.
 */
function isPerSecondRateLimited(response) {
  if (response.status !== 'OVER_QUERY_LIMIT') return false;
  if (isDailyQuotaExhausted(response)) return false;
  const message = response.error_message;
  if (!message) return true;
  return /rate.?limit|per.?second|too many requests|short.?term|qps/i.test(message);
}

// Nominatim requests actually put on the wire this run (cache hits excluded),
// and the timestamp of the last one, so the 1/second floor holds across the
// whole run rather than per call site.
let nominatimRequests = 0;
let nominatimCacheHits = 0;
let lastNominatimAt = 0;

/**
 * Cache path for one venue+country lookup. Keyed on the normalised pair, so
 * two spellings of the same ground share an entry and a venue name that
 * collides across countries does not.
 */
function osmCachePath(venue, countryName) {
  const key = `${normalizeForMatch(venue)}__${normalizeForMatch(countryName)}`
    .replace(/[^a-z0-9_]+/g, '-').slice(0, 180);
  return path.join(OSM_CACHE_DIR, `${key}.json`);
}

/**
 * The Nominatim URL for one query string. Factored out because the query a
 * cached answer was fetched with is not necessarily the query this call would
 * build: osmCachePath keys on normalizeForMatch(venue)__normalizeForMatch(
 * country), so two spellings of one ground share an entry, and the recorded URL
 * has to be the one that actually produced the results.
 */
function nominatimUrl(query) {
  return `https://${NOMINATIM_HOST}/search?q=${encodeURIComponent(query)}`
    + '&format=jsonv2&limit=8&addressdetails=1';
}

/**
 * Ask Nominatim for a venue, honouring the 1 request/second policy and reading
 * through a disk cache first. A cached answer costs nothing and is what makes
 * re-running the geocoder cheap; only a genuine miss goes to the network.
 *
 * Returns { status, results, url, fromCache, error }, where status separates
 * the two outcomes that used to be indistinguishable:
 *   'ok'     the request succeeded and OSM returned at least one feature
 *   'empty'  the request succeeded and OSM knows nothing about this venue
 *   'failed' network error, timeout, non-200 or unparseable body
 * 'empty' is a fact about the world; 'failed' is a fact about the run, and only
 * one of them says anything about the venue. Collapsing both to null made an
 * outage read like universal absence in the sidecar.
 *
 * fromCache says whether this answer came off disk or off the wire. A re-run is
 * almost entirely cache hits, and after the fact there is nothing in the file to
 * tell a verified row from a reused one, so it is recorded rather than inferred.
 *
 * A failure here is still never fatal and never an acceptance: results is null,
 * and the caller falls through to the name-match path exactly as if OSM had
 * returned nothing. OSM being down must not turn into a wrong coordinate.
 */
async function queryOpenStreetMap(venue, countryName) {
  // What THIS call would ask, used only if the request actually goes out. On a
  // cache hit the recorded URL is rebuilt from the cached query instead: the
  // cache is keyed on the normalised venue+country, so a second spelling of the
  // same ground hits an entry fetched under the first spelling, and building the
  // URL from these raw values would record a request nobody ever made.
  const query = `${venue}, ${String(countryName || '').replace(/-/g, ' ')}`;

  const cacheFile = osmCachePath(venue, countryName);

  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // Both fields are required: an entry that cannot say which query produced
    // it cannot be attributed, and is treated as a miss rather than recorded
    // under a URL guessed from the caller's spelling.
    if (Array.isArray(cached.results) && typeof cached.query === 'string') {
      nominatimCacheHits++;
      return {
        status: cached.results.length > 0 ? 'ok' : 'empty',
        results: cached.results,
        url: nominatimUrl(cached.query),
        fromCache: true,
        error: null,
      };
    }
  } catch (err) {
    // Cache miss or unreadable entry: fall through and ask.
  }

  const url = nominatimUrl(query);

  const since = Date.now() - lastNominatimAt;
  if (since < NOMINATIM_DELAY_MS) await sleep(NOMINATIM_DELAY_MS - since);

  let results;
  try {
    results = await new Promise((resolve, reject) => {
      const req = https.get(url,
        { headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'en' } },
        (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            try {
              resolve(JSON.parse(data));
            } catch (parseErr) {
              reject(new Error(`JSON parse error: ${parseErr.message}`));
            }
          });
        });
      // destroy(err) tears the socket down and surfaces as 'error' below, so a
      // timeout lands on the same failure path as a refused connection.
      req.setTimeout(NOMINATIM_TIMEOUT_MS, () => {
        req.destroy(new Error(`timeout after ${NOMINATIM_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
    });
  } catch (err) {
    console.log(`      OSM lookup failed (${err.message}) - falling through`);
    return {
      status: 'failed', results: null, url, fromCache: false,
      error: String(err.message),
    };
  } finally {
    lastNominatimAt = Date.now();
    nominatimRequests++;
  }

  if (!Array.isArray(results)) {
    // A 200 that is valid JSON but not a result array: the request worked, the
    // payload did not, so it is a failure of the lookup, not an empty answer.
    return {
      status: 'failed', results: null, url, fromCache: false,
      error: `unexpected payload shape (${typeof results})`,
    };
  }

  try {
    fs.mkdirSync(OSM_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      query, fetchedAt: new Date().toISOString(), results,
    }, null, 2));
  } catch (err) {
    console.log(`      OSM cache write failed (${err.message}) - continuing`);
  }

  return {
    status: results.length > 0 ? 'ok' : 'empty',
    results,
    url,
    fromCache: false,
    error: null,
  };
}

/**
 * Tier 2's OSM test. Returns both halves of what OSM had to say, kept apart on
 * purpose:
 *
 *   match    the nearest qualifying feature WITHIN OSM_MATCH_RADIUS_KM, or
 *            null. This alone is the corroboration decision - acceptance reads
 *            this field and nothing else.
 *   nearest  the nearest qualifying feature at ANY distance, or null. Recorded,
 *            never consulted. A rejected venue whose nearest stadium sits 0.6km
 *            away is a different problem from one whose nearest sits 40km away,
 *            and the old code threw that distinction away at the radius test.
 *
 * match, when non-null, is the same object as nearest. Widening the radius is
 * therefore NOT what this function does: it records what was discarded so the
 * radius can be judged later from the sidecar rather than from another run.
 */
async function findOsmCorroboration(venue, countryName, lat, lng) {
  const { status, results, url, fromCache, error } =
    await queryOpenStreetMap(venue, countryName);

  const outcome = {
    match: null,
    nearest: null,
    candidateCount: 0,
    status,
    error,
    queryUrl: url,
    fromCache,
  };

  if (!Array.isArray(results)) return outcome;

  for (const r of results) {
    if (!OSM_SPORT_TYPES.has(r.type)) continue;
    const osmLat = parseFloat(r.lat);
    const osmLon = parseFloat(r.lon);
    if (!Number.isFinite(osmLat) || !Number.isFinite(osmLon)) continue;

    outcome.candidateCount++;
    const km = haversineKm(lat, lng, osmLat, osmLon);
    if (!outcome.nearest || km < outcome.nearest.km) {
      outcome.nearest = {
        km, lat: osmLat, lon: osmLon,
        category: r.category, type: r.type, name: r.display_name,
      };
    }
  }

  // The radius test, applied once, to the nearest candidate. Anything further
  // out could not have won it anyway.
  if (outcome.nearest && outcome.nearest.km <= OSM_MATCH_RADIUS_KM) {
    outcome.match = outcome.nearest;
  }

  return outcome;
}

/**
 * Geocode, retrying per-second rate limiting ONLY: at most
 * RATE_LIMIT_MAX_ATTEMPTS attempts for this stadium, doubling the backoff each
 * time. A daily-quota response throws RunAborted instead. Every other status -
 * ZERO_RESULTS, REQUEST_DENIED, an unrecognised OVER_QUERY_LIMIT - is returned
 * immediately, since retrying those just burns quota. Returns
 * { response, retries }.
 */
async function geocodeWithRetry(address, iso2) {
  let response = await geocodeAddress(address, iso2);
  let retries = 0;

  for (let attempt = 2; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    if (!isPerSecondRateLimited(response)) break;
    const waitMs = RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 2);
    retries++;
    console.log(`    Rate limited - retry ${retries}/${RATE_LIMIT_MAX_ATTEMPTS - 1}`
      + ` after ${waitMs / 1000}s`);
    await sleep(waitMs);
    response = await geocodeAddress(address, iso2);
  }

  // Covers both the first response and anything a retry turned up.
  if (isDailyQuotaExhausted(response)) {
    throw new RunAborted('daily-quota',
      response.error_message || 'Google reports the daily geocoding quota is exhausted');
  }

  return { response, retries };
}

/**
 * Which of the two input shapes this file is, decided from the parsed data and
 * not from the filename. Returns null for anything else, which the caller turns
 * into a refusal: guessing at an unrecognised structure is how a run silently
 * geocodes nothing, or writes a file back in a shape its consumers cannot read.
 */
function detectShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (Array.isArray(data.venues)) return 'flat';
  if (data.countries && typeof data.countries === 'object'
    && !Array.isArray(data.countries)) {
    return 'nested';
  }
  return null;
}

/**
 * How many venue records a parsed file holds, in either shape. Taken once
 * before the run and once before the write, so a refactor that loses records
 * cannot quietly overwrite the input with a shorter file.
 */
function countRecords(data, shape) {
  if (shape === 'flat') return Array.isArray(data.venues) ? data.venues.length : 0;

  let total = 0;
  for (const countryData of Object.values(data.countries || {})) {
    for (const league of (countryData.leagues || [])) {
      total += (league.stadiums || []).length;
    }
  }
  return total;
}

/**
 * The nested shape as items. The record's own field names are already the ones
 * the geocoding loop reads and writes, so the view IS the record: no accessor
 * layer, and therefore nothing in the default path that can drift from what the
 * script did before --input existed.
 */
function nestedItems(data) {
  const items = [];

  for (const [countryName, countryData] of Object.entries(data.countries)) {
    for (const league of countryData.leagues) {
      const total = league.stadiums.length;

      league.stadiums.forEach((stadium, i) => {
        const areaCode = (stadium.area && stadium.area.code) || null;
        items.push({
          shape: 'nested',
          record: stadium,
          view: stadium,
          clearCity: () => { delete stadium.city; },
          country: countryName,
          league: league.name,
          areaCode,
          iso2: AREA_CODE_TO_ISO2[areaCode] || null,
          teamIds: stadium.teamId === undefined || stadium.teamId === null
            ? []
            : [stadium.teamId],
          displayName: stadium.teamName || stadium.name || stadium.venue,
          label: `[${i + 1}/${total}] ${stadium.teamName || stadium.name}`,
          groups: [countryName, `${league.name} (${total} teams)`],
          forceGeocode: false,
        });
      });
    }
  }

  return items;
}

/**
 * The flat shape as items. `name` is the only field whose name differs from
 * what the loop expects, so the view is a thin set of accessors that write
 * straight through to the record - the output file keeps the flat structure and
 * gains nothing but the geocoder's own fields.
 *
 * `address` is exposed only because applyVenueOverride writes it. It is NOT
 * reachable from buildAddress, which reads venue and city alone: api-football's
 * address is a street address and putting it in the query drags the result off
 * the ground, exactly as football-data's does. The A/B test settled that.
 */
function flatItems(data) {
  const total = data.venues.length;

  return data.venues.map((record, i) => {
    const teamIds = Array.isArray(record.teamIds)
      ? record.teamIds.filter(id => id !== null && id !== undefined)
      : [];

    return {
      shape: 'flat',
      record,
      view: {
        get venue() { return record.name; },
        set venue(value) { record.name = value; },
        get city() { return record.city; },
        set city(value) { record.city = value; },
        get address() { return record.address; },
        set address(value) { record.address = value; },
        get fullAddress() { return record.fullAddress; },
        set fullAddress(value) { record.fullAddress = value; },
        get latitude() { return record.latitude; },
        set latitude(value) { record.latitude = value; },
        get longitude() { return record.longitude; },
        set longitude(value) { record.longitude = value; },
        get acceptedTier() { return record.acceptedTier; },
        set acceptedTier(value) { record.acceptedTier = value; },
        get acceptedBy() { return record.acceptedBy; },
        set acceptedBy(value) { record.acceptedBy = value; },
      },
      clearCity: () => { delete record.city; },
      country: record.country || null,
      league: null,
      areaCode: null,
      iso2: COUNTRY_NAME_TO_ISO2[record.country] || null,
      teamIds,
      displayName: Array.isArray(record.teamNames) && record.teamNames.length > 0
        ? record.teamNames.join(' / ')
        : record.name,
      // No country/league headers to print: the flat file has no such
      // structure, so the country rides along on the label instead.
      label: `[${i + 1}/${total}] ${record.name} (${record.country || 'no country'})`,
      groups: [],
      // carryExcluded marks the NO_CARRY list. Those venues must be geocoded
      // even if something has since put coordinates on them - that is the whole
      // point of excluding them from the carry-forward.
      forceGeocode: record.carryExcluded === true,
    };
  });
}

/**
 * The identity fields of a sidecar record. The shapes identify a row
 * differently and there is no honest way to flatten that: a nested row is one
 * team at one ground, a flat row is one ground shared by any number of teams.
 */
function identityFields(item) {
  if (item.shape === 'flat') {
    return {
      venueId: item.record.venueId ?? null,
      teamIds: [...item.teamIds],
      teamNames: Array.isArray(item.record.teamNames)
        ? [...item.record.teamNames]
        : [],
      teamName: item.displayName ?? null,
    };
  }

  return {
    teamId: item.record.teamId ?? null,
    teamName: item.record.teamName ?? null,
  };
}

/**
 * The fields every sidecar record carries, whatever happened to it. Built from
 * the item's view, so one definition serves both shapes and the raw file stays
 * uniform within a run.
 */
function baseRecord(item) {
  return {
    ...identityFields(item),
    venue: item.view.venue,
    city: item.view.city ?? null,
    country: item.country,
    league: item.league,
    areaCode: item.areaCode,
    iso2: item.iso2,
    query: null,
    missingSegments: [],
    cachedLat: item.view.latitude ?? null,
    cachedLng: item.view.longitude ?? null,
    response: null,
    fetchError: null,
    outcome: null,
    // Present on every record so the sidecar is one uniform shape and an
    // absent field never has to be read as "no OSM call" or "no tier".
    // null means the question was never reached: tier is null only for
    // records that were never evaluated (skipped, overridden, errored),
    // and the osm* fields are null on tier 1 and tier 3, which spend no
    // Nominatim request by design.
    tier: null,
    googleLocationType: null,
    osmStatus: null,
    osmError: null,
    osmQueryUrl: null,
    osmFromCache: null,
    osmCandidateCount: null,
    osmNearest: null,
  };
}

/**
 * Sidecar entry for a venue the run never queried. Same shape as every other
 * record, with response/query null because no request was made and the cached
 * coordinates echoed back as what it kept.
 */
function skipRecord(item, reason) {
  return {
    ...baseRecord(item),
    iso2: null,
    outcome: 'skipped',
    skipReason: reason,
  };
}

/**
 * Add coordinates to all stadiums
 */
async function geocodeStadiums() {
  console.log('GEOCODING STADIUMS\n');
  console.log(`Mode:   ${APPLY ? 'APPLY (writes the input file itself)' : 'DRY (candidate file only)'}`);
  if (TEAM_FILTER) {
    console.log(`Scope:  --team=${[...TEAM_FILTER].join(',')} (${TEAM_FILTER.size} team(s);`
      + ' geocoded even if they already have coordinates)');
    if (ONLY_MISSING) console.log('        --only-missing ignored: --team selects explicitly');
  } else if (ONLY_MISSING) {
    console.log('Scope:  --only-missing (stadiums with usable coordinates are skipped)');
  } else {
    console.log('Scope:  all stadiums (re-queries records that already have coordinates)');
  }
  console.log(`Input:  ${INPUT_PATH}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Raw:    ${RAW_PATH}`);
  console.log('');

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`ERROR: input file not found: ${INPUT_PATH}`);
    if (IS_DEFAULT_INPUT) console.error('   Run export-stadiums-proxy.js first');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));

  // Shape comes from the data, never the filename.
  const shape = detectShape(data);
  if (!shape) {
    console.error(`ERROR: ${INPUT_PATH} is not a shape this script can geocode.`);
    console.error('');
    console.error('   Expected ONE of:');
    console.error('     a top-level "venues" array   (flat, api-football)');
    console.error('     a top-level "countries" object (nested, football-data)');
    console.error('');
    console.error('   Found top-level keys: '
      + (data && typeof data === 'object' ? Object.keys(data).join(', ') || '(none)' : typeof data));
    console.error('   Refusing to guess.');
    process.exit(1);
  }

  const inputCount = countRecords(data, shape);
  const items = shape === 'flat' ? flatItems(data) : nestedItems(data);

  console.log(`Shape:  ${shape === 'flat'
    ? 'flat venues[] (venue name in "name", identity venueId)'
    : 'nested countries[].leagues[].stadiums[] (venue name in "venue", identity teamId)'}`);
  if (shape === 'nested') {
    console.log(`Loaded: ${data.totalStadiums} stadiums from ${data.totalCountries} countries\n`);
  } else {
    console.log(`Loaded: ${inputCount} venues`
      + `${data.totalVenues !== undefined ? ` (file reports totalVenues ${data.totalVenues})` : ''}\n`);
  }

  let accepted = 0;
  let overridden = 0;
  let skipped = 0;
  let geocoded = 0;
  let acceptedByType = 0;
  let acceptedByName = 0;
  let acceptedByOsm = 0;
  let tier3Rejected = 0;
  let overrideConflicts = 0;
  let overrideNamespaceMismatches = 0;
  const nameMatches = [];
  const osmMatches = [];
  let rejected = 0;
  let errored = 0;
  const rejections = [];
  const rawRecords = [];

  // Set by the stadium loop when the run has to stop early (daily quota gone,
  // or MAX_REQUESTS hit). The loops unwind on it rather than throwing, so
  // control still reaches the write step below and the partial run is saved.
  let aborted = null;

  // Every venue is re-queried, including ones that already have coordinates: a
  // rejection keeps the existing values, so a re-run can only improve a record
  // or leave it untouched. One loop over the normalised items, so nothing below
  // this line knows which shape was loaded.
  let printedGroups = [];

  for (const item of items) {
    const { view, label } = item;

    // Country/league headers for the nested shape. The flat shape has no such
    // structure and declares no groups, so this prints nothing for it.
    for (let depth = 0; depth < item.groups.length; depth++) {
      const changed = item.groups
        .slice(0, depth + 1)
        .some((group, d) => printedGroups[d] !== group);
      if (!changed) continue;
      console.log(`\n${item.groups[depth]}`);
      if (depth === 0) console.log('-'.repeat(50));
    }
    printedGroups = item.groups;

    // Selection runs before everything else, overrides included: a scoped
    // run must leave every record outside its scope byte-identical, and an
    // override rewrites fields. Records skipped here keep their coordinates,
    // their city, and everything else exactly as loaded.
    if (TEAM_FILTER && !item.teamIds.some(id => TEAM_FILTER.has(id))) {
      skipped++;
      rawRecords.push(skipRecord(item, 'not-in-team-filter'));
      continue;
    }

    // Overrides win outright and cost no API call. Applied here, after the
    // geocoding step in pipeline order, so an override always beats a
    // geocoded value for the same record.
    const { override, id: overrideTeamId, conflict, mismatched } = resolveOverride(item);
    overrideNamespaceMismatches += mismatched;

    if (conflict) {
      // Two entries disagree about one ground. Guessing would write one club's
      // correction onto another club's venue, so the record is geocoded
      // normally instead and the collision is left visible.
      overrideConflicts++;
      console.log(`  ${label}`);
      console.log(`    OVERRIDE CONFLICT - team ids ${conflict.join(', ')} on this one`);
      console.log('      record carry different overrides. Not guessing: no override');
      console.log('      applied, geocoding this record normally.');
    } else if (override) {
      applyVenueOverride(view, override);
      overridden++;
      console.log(`  ${label}`);
      console.log(`    OVERRIDE - skipping geocode`);
      console.log(`      venue: ${view.venue}`);
      console.log(`      city:  ${view.city ?? '(none)'}`);
      console.log(`      coords: ${view.latitude}, ${view.longitude}`);
      console.log(`      reason: ${override.reason || '(none given)'}`);
      rawRecords.push({
        ...baseRecord(item),
        iso2: null,
        outcome: 'override',
        override,
        overrideTeamId,
      });
      continue;
    }

    // Checked after the override block on purpose: an override costs no
    // API request, so --only-missing has no reason to suppress one. Only
    // --team, which means "touch nothing else", skips overrides too.
    // forceGeocode wins over the coordinate test: a NO_CARRY venue is on that
    // list because its coordinates are not to be trusted.
    if (ONLY_MISSING && !TEAM_FILTER && !item.forceGeocode && hasValidCoordinates(view)) {
      skipped++;
      console.log(`  ${label}`);
      console.log(`    SKIP - already has coordinates: `
        + `${view.latitude}, ${view.longitude}`);
      rawRecords.push(skipRecord(item, 'has-coordinates'));
      continue;
    }

    const { address, missing } = buildAddress(view, item.country);
    const iso2 = item.iso2;

    const record = baseRecord(item);
    record.query = address;
    record.missingSegments = missing;

    // The stored city feeds the query only. It is dropped here so it can
    // never survive into the output; an accepted response re-derives it.
    const storedCity = view.city;
    item.clearCity();

    geocoded++;
    console.log(`  ${label}`);
    if (item.forceGeocode) {
      console.log('    (carryExcluded - on the NO_CARRY list, geocoded regardless)');
    }
    console.log(`    Query: ${address}${iso2 ? `  [country:${iso2}]` : '  [no country filter]'}`);

    try {
      const { response, retries } = await geocodeWithRetry(address, iso2);
      record.response = response;
      record.overQueryLimitRetries = retries;

      const top = response.status === 'OK' && Array.isArray(response.results)
        && response.results.length > 0
        ? response.results[0]
        : null;
      const types = (top && top.types) || [];

      // ---- THREE-TIER ACCEPTANCE ----
      //
      // 1  types includes 'stadium'                      - free, decisive
      // 2  OSM corroborates the point, OR the venue name
      //    appears in the formatted address               - costs an OSM call
      // 3  types describe only an area                    - reject, no OSM call
      //
      // Tier 3 is evaluated BEFORE tier 2 so a town-centre fallback never
      // spends a Nominatim request. Tier 1 is evaluated before both so the
      // common case stays free.
      const byType = !!(top && types.includes('stadium'));
      const areaOnly = !byType && !!top && isAreaOnlyResult(types);

      // The tier a record was decided at, recorded whatever the outcome.
      // A response with no usable result reaches tier 2 - there is nothing
      // area-only about it - but has no point for OSM to corroborate, so it
      // is rejected there without a Nominatim request.
      const tier = byType ? 1 : (areaOnly ? 3 : 2);
      record.tier = tier;
      record.googleLocationType = (top && top.geometry && top.geometry.location_type) || null;

      let osmMatch = null;
      let byName = false;

      if (top && !byType && !areaOnly) {
        const osm = await findOsmCorroboration(
          view.venue, item.country,
          top.geometry.location.lat, top.geometry.location.lng
        );

        // Recorded on every tier-2 record, accepted or rejected, and
        // recorded BEFORE the acceptance test so a rejection carries the
        // same evidence an acceptance does. osmNearest may sit far outside
        // OSM_MATCH_RADIUS_KM; it is evidence, not a decision.
        record.osmStatus = osm.status;
        record.osmError = osm.error;
        record.osmQueryUrl = osm.queryUrl;
        record.osmFromCache = osm.fromCache;
        record.osmCandidateCount = osm.candidateCount;
        record.osmNearest = osm.nearest;

        // Only the within-radius match decides anything.
        osmMatch = osm.match;

        // The name-match path is kept as a second tier-2 route: it is what
        // recovered Nagyerdei Stadion, whose correct street address simply
        // was not tagged as a stadium and which OSM may not hold either.
        if (!osmMatch) {
          byName = venueNameMatches(view.venue, top.formatted_address);
        }
      }

      if (areaOnly) tier3Rejected++;

      if (byType || osmMatch || byName) {
        view.latitude = top.geometry.location.lat;
        view.longitude = top.geometry.location.lng;

        const city = extractCity(top.address_components || []);
        if (city) {
          view.city = city;
        }

        const acceptedBy = byType ? 'stadium-type' : (osmMatch ? 'osm-corroborated' : 'name-match');

        record.outcome = 'accepted';
        record.acceptedBy = acceptedBy;
        record.acceptedTier = tier;
        // Persisted so a later reviewer can see WHY a tier-2 record was
        // trusted without re-querying anything.
        record.osmMatch = osmMatch;
        view.acceptedTier = tier;
        view.acceptedBy = acceptedBy;

        accepted++;
        if (byType) {
          acceptedByType++;
        } else if (osmMatch) {
          acceptedByOsm++;
          osmMatches.push({
            teamName: item.displayName,
            venue: view.venue,
            country: item.country,
            formatted: top.formatted_address,
            types,
            osm: osmMatch,
          });
        } else {
          acceptedByName++;
          nameMatches.push({
            teamName: item.displayName,
            venue: view.venue,
            country: item.country,
            formatted: top.formatted_address,
            types,
          });
        }

        console.log(`    ACCEPTED [tier ${tier}: ${acceptedBy}] `
          + `${view.latitude}, ${view.longitude}${city ? ` (${city})` : ''}`);
        if (osmMatch) {
          console.log(`      OSM ${osmMatch.category}/${osmMatch.type} `
            + `${osmMatch.km.toFixed(3)}km away: ${osmMatch.name}`);
        }
        if (byName) console.log(`      matched: ${top.formatted_address}`);
      } else {
        // A rejection must never strip a field: put the cached city back.
        if (storedCity !== undefined) {
          view.city = storedCity;
        }
        record.outcome = 'rejected';
        record.rejectedTier = tier;
        record.osmMatch = null;
        rejected++;
        const rejection = {
          teamName: item.displayName,
          venue: view.venue,
          country: item.country,
          league: item.league,
          query: address,
          status: response.status,
          formatted: top ? top.formatted_address : null,
          types,
          keptLat: view.latitude ?? null,
          keptLng: view.longitude ?? null,
        };
        rejections.push(rejection);
        console.log(`    REJECTED [tier ${areaOnly ? '3: area-only, no OSM call' : '2: no corroboration'}]`
          + ` (${response.status})`);
        console.log(`      got:   ${top ? top.formatted_address : '(no result)'}`);
        console.log(`      types: ${types.length ? types.join(', ') : '(none)'}`);
        // The near miss, when there was one: a nearest OSM feature just
        // outside the radius reads very differently from one 40km away.
        if (record.osmNearest) {
          console.log(`      osm nearest (not corroborating): `
            + `${record.osmNearest.category}/${record.osmNearest.type} `
            + `${record.osmNearest.km.toFixed(3)}km - ${record.osmNearest.name}`);
        } else if (record.osmStatus) {
          console.log(`      osm: ${record.osmStatus}`
            + `${record.osmError ? ` (${record.osmError})` : ''}`);
        }
        console.log(`      keeping cached: ${rejection.keptLat}, ${rejection.keptLng}`);
      }
    } catch (err) {
      if (err instanceof RunAborted) {
        // Not this venue's fault: it keeps its cached values like any
        // rejection, and the run stops here.
        if (storedCity !== undefined) {
          view.city = storedCity;
        }
        record.fetchError = err.message;
        record.outcome = 'aborted';
        rawRecords.push(record);
        aborted = err;
        console.error(`    ABORTING RUN - ${err.message}`);
        console.log(`      keeping cached: ${view.latitude}, ${view.longitude}`);
        break;
      }
      record.fetchError = String(err.message);
      // Same as a rejection: keep whatever the cache already had.
      if (storedCity !== undefined) {
        view.city = storedCity;
      }
      record.outcome = 'error';
      errored++;
      rejections.push({
        teamName: item.displayName,
        venue: view.venue,
        country: item.country,
        league: item.league,
        query: address,
        status: `ERROR: ${err.message}`,
        formatted: null,
        types: [],
        keptLat: view.latitude ?? null,
        keptLng: view.longitude ?? null,
      });
      console.error(`    ERROR: ${err.message}`);
      console.log(`      keeping cached: ${view.latitude}, ${view.longitude}`);
    }

    rawRecords.push(record);
    await sleep(CALL_DELAY_MS);
  }

  // Update metadata
  data.lastGeocoded = new Date().toISOString().split('T')[0];
  data.geocodingStats = {
    accepted,
    acceptedByType,
    acceptedByOsm,
    acceptedByName,
    tier3Rejected,
    osmRequests: nominatimRequests,
    osmCacheHits: nominatimCacheHits,
    overridden,
    overrideConflicts,
    overrideNamespaceMismatches,
    overrideIdSource: VENUE_OVERRIDES_ID_SOURCE,
    inputIdSource: SHAPE_ID_SOURCE[shape] || null,
    rejected,
    errored,
    skipped,
    geocoded,
    total: accepted + overridden + rejected + errored,
    totalStadiums: accepted + overridden + rejected + errored + skipped,
    inputPath: INPUT_PATH,
    inputShape: shape,
    scope: TEAM_FILTER
      ? { mode: 'team', teamIds: [...TEAM_FILTER] }
      : { mode: ONLY_MISSING ? 'only-missing' : 'all' },
    requestsUsed: requestCount,
    requestCeiling: MAX_REQUESTS,
    aborted: aborted ? { reason: aborted.reason, message: aborted.message } : null,
  };

  // The sidecar goes first, and unconditionally. It is the only record of work
  // that has already been paid for, and the guard below can refuse the output.
  fs.writeFileSync(RAW_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    input: INPUT_PATH,
    inputShape: shape,
    queryShape: "venue + ', ' + relaxCity(city) + ', ' + countryName; components=country:<ISO2>",
    acceptanceRule: {
      tier1: "results[0].types includes 'stadium'",
      tier2: `OSM leisure=stadium|pitch|sports_centre within ${OSM_MATCH_RADIUS_KM}km of results[0], `
        + 'or venue name contained in formatted_address',
      tier3: 'reject without an OSM call when types are area-only '
        + '(locality/political/sublocality/administrative_area_*/neighborhood/colloquial_area/route)',
    },
    // What every record carries, and - as important - what it does not mean.
    recordFields: {
      tier: '1, 2 or 3; null only for records never evaluated (skipped, overridden, errored)',
      googleLocationType: 'results[0].geometry.location_type, null when there was no result',
      osmStatus: "'ok' | 'empty' | 'failed'; null on tiers 1 and 3, which spend no OSM request",
      osmError: 'failure reason when osmStatus is failed, else null',
      osmQueryUrl: 'the Nominatim URL that produced these results. On a cache hit it is '
        + 'rebuilt from the cached entry\'s own query, NOT from this row\'s venue/country: '
        + 'the cache is keyed on the normalised pair, so the fetch may have been made '
        + 'under a different spelling of the same ground',
      osmFromCache: 'true if these results came off disk, false if this run fetched them; '
        + 'null on tiers 1 and 3. A re-run is almost all true - it is the only record '
        + 'of which rows this run actually put on the wire',
      osmCandidateCount: 'qualifying OSM features seen at ANY distance',
      osmNearest: `nearest qualifying feature at ANY distance - EVIDENCE ONLY. `
        + `Corroboration still required km <= ${OSM_MATCH_RADIUS_KM}; a record with an `
        + 'osmNearest beyond that was rejected, not accepted',
    },
    osmMatchRadiusKm: OSM_MATCH_RADIUS_KM,
    osmTimeoutMs: NOMINATIM_TIMEOUT_MS,
    osmRequests: nominatimRequests,
    osmCacheHits: nominatimCacheHits,
    mode: APPLY ? 'apply' : 'candidate',
    requestsUsed: requestCount,
    aborted: aborted ? { reason: aborted.reason, message: aborted.message } : null,
    count: rawRecords.length,
    records: rawRecords,
  }, null, 2));

  // Pre-write tripwire. Nothing in this script adds or removes a record, so an
  // output holding fewer than the input did means a bug in the normalising
  // layer, not a smaller world - and with --apply the output IS the input, so
  // writing it would destroy the records it lost. Refuse instead. The sidecar
  // above is already on disk, so a refusal never costs the run's API spend.
  const outputCount = countRecords(data, shape);
  if (outputCount < inputCount) {
    console.error('\n' + '='.repeat(60));
    console.error('REFUSING TO WRITE: the output holds fewer records than the input.');
    console.error(`   input:  ${inputCount}`);
    console.error(`   output: ${outputCount}  (${inputCount - outputCount} lost)`);
    console.error(`   would have written: ${OUTPUT_PATH}`);
    console.error('   This is a bug in the script, not a data condition. Nothing was');
    console.error(`   written except the sidecar: ${RAW_PATH}`);
    console.error('='.repeat(60));
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log(aborted ? 'GEOCODING ABORTED - PARTIAL RESULTS SAVED' : 'GEOCODING COMPLETE');
  console.log('='.repeat(60));
  console.log('Statistics:');
  console.log(`   Accepted total:                     ${accepted}`);
  console.log(`     tier 1 - "stadium" type:          ${acceptedByType}`);
  console.log(`     tier 2 - OSM corroborated:        ${acceptedByOsm}`);
  console.log(`     tier 2 - venue-name match:        ${acceptedByName}`);
  console.log(`   Rejected:                           ${rejected}`);
  console.log(`     tier 3 - area-only (no OSM call): ${tier3Rejected}`);
  console.log(`   OSM requests made:                  ${nominatimRequests}`);
  console.log(`   OSM cache hits (no request):        ${nominatimCacheHits}`);
  console.log(`   Errored:                            ${errored}`);
  console.log(`   Geocoded (API request made):        ${geocoded}`);
  console.log(`   Overridden (geocode skipped):       ${overridden}`);
  if (overrideConflicts > 0) {
    console.log(`   Override conflicts (none applied):  ${overrideConflicts}`);
  }
  // Printed unconditionally, zero included: the whole point of the count is
  // that a re-keyed overrides file looks different from one that has not been
  // re-keyed, and a line that only appears on failure cannot show that.
  console.log(`   Overrides skipped, wrong id source: ${overrideNamespaceMismatches}`
    + `  (file is "${VENUE_OVERRIDES_ID_SOURCE}", this input is`
    + ` "${SHAPE_ID_SOURCE[shape]}")`);
  console.log(`   Skipped (not selected):             ${skipped}`);
  console.log(`   Total stadiums seen:                ${accepted + overridden + rejected + errored + skipped}`);
  console.log(`   API requests used:                  ${requestCount} / ${MAX_REQUESTS}`);

  if (osmMatches.length > 0) {
    console.log('\nAccepted via OSM corroboration (tier 2) - Google had no "stadium" type:');
    for (const m of osmMatches) {
      console.log(`   ${m.teamName} (${m.country})`);
      console.log(`      venue: ${m.venue}`);
      console.log(`      got:   ${m.formatted}`);
      console.log(`      types: ${m.types.join(', ')}`);
      console.log(`      osm:   ${m.osm.category}/${m.osm.type} at ${m.osm.km.toFixed(3)}km - ${m.osm.name}`);
    }
  }

  if (nameMatches.length > 0) {
    console.log('\nAccepted via venue-name match (no "stadium" type) - worth eyeballing:');
    for (const m of nameMatches) {
      console.log(`   ${m.teamName} (${m.country})`);
      console.log(`      venue: ${m.venue}`);
      console.log(`      got:   ${m.formatted}`);
      console.log(`      types: ${m.types.join(', ')}`);
    }
  }

  if (rejections.length > 0) {
    console.log('\nRejected / errored - these kept their existing coordinates:');
    for (const r of rejections) {
      console.log(`   ${r.teamName} (${r.country}) - ${r.status}`);
      console.log(`      query: ${r.query}`);
      console.log(`      got:   ${r.formatted || '(no result)'}`);
      console.log(`      types: ${r.types.length ? r.types.join(', ') : '(none)'}`);
      console.log(`      kept:  ${r.keptLat}, ${r.keptLng}`);
    }
  }

  console.log('\nSaved to:');
  console.log(`   ${OUTPUT_PATH}`);
  console.log(`   ${RAW_PATH} (raw responses)`);
  if (!APPLY) {
    console.log('\n   DRY RUN - stadiums-premium.json was not modified.');
    console.log('   Re-run with --apply to write it for real.');
  }
  console.log('');

  if (aborted) {
    console.error('='.repeat(60));
    if (aborted.reason === 'daily-quota') {
      console.error('RUN ABORTED: Google reports the daily geocoding quota is exhausted.');
      console.error(`   Google said: ${aborted.message}`);
      console.error('   Every retry would be another billable request against a quota');
      console.error('   that cannot succeed again until it resets (midnight US/Pacific).');
    } else {
      console.error(`RUN ABORTED: ${aborted.message}.`);
      console.error('   Raise it with GEOCODE_MAX_REQUESTS=<n> if this run needs more.');
    }
    console.error(`   ${requestCount} requests were used before stopping.`);
    console.error('   Everything geocoded up to that point has been written to:');
    console.error(`      ${OUTPUT_PATH}`);
    console.error('   Stadiums not reached keep their existing coordinates untouched.');
    console.error('   Re-run to resume - accepted records are simply re-confirmed.');
    console.error('='.repeat(60));
    process.exit(1);
  }
}

// Check for the geocoding key. The variable is named; its value is not read
// back, measured or echoed in any form.
if (!GOOGLE_API_KEY) {
  console.error('ERROR: REACT_APP_GOOGLE_GEOCODING_KEY is not set.');
  console.error('');
  console.error('Set it in your environment:');
  console.error('export REACT_APP_GOOGLE_GEOCODING_KEY=<geocoding key>');
  console.error('');
  console.error('REACT_APP_GOOGLE_MAPS_API_KEY is NOT accepted as a substitute:');
  console.error('the browser Maps key is referrer-restricted and fails');
  console.error('server-side with REQUEST_DENIED on every request.');
  process.exit(1);
}

// Run geocoding
geocodeStadiums().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
