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
 * Acceptance: results[0] is accepted only if its types array contains
 *   "stadium". Anything else is rejected and the stadium keeps whatever
 *   coordinates it already had - a bad match never overwrites good data,
 *   and a rejection never nulls a record.
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
 * Output: stadiums-premium-candidate.json by default. Pass --apply to write
 *   stadiums-premium.json for real. Every complete API response is persisted
 *   to a sidecar JSON next to the output.
 *
 * Selection: every stadium is re-queried by default. --only-missing narrows
 *   the run to records without usable coordinates; --team=<ids> narrows it to
 *   an explicit list and ignores --only-missing, so a single ground can be
 *   re-resolved even though it already has coordinates. Skipped records are
 *   not touched at all - they keep every field exactly as loaded.
 *
 * Usage: node scripts/geocode-stadiums.js [--apply] [--only-missing] [--team=<id,id>]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

// Resolved from __dirname so the script reads and writes the repo-root files
// no matter which directory it is run from.
const ROOT = path.join(__dirname, '..');

// Read Google API key from environment. The dedicated geocoding key is
// preferred: a browser Maps key is usually HTTP-referrer restricted and
// fails server-side with REQUEST_DENIED.
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_GEOCODING_KEY
  || process.env.REACT_APP_GOOGLE_MAPS_API_KEY
  || 'YOUR_KEY_HERE';

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

const INPUT_PATH = path.join(ROOT, 'stadiums-premium.json');
const OUTPUT_PATH = APPLY
  ? INPUT_PATH
  : path.join(ROOT, 'stadiums-premium-candidate.json');
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
 * Manual corrections for venues football-data.org has not updated, keyed by
 * teamId. An entry here is authoritative: the stadium is NOT geocoded at all,
 * because an override exists precisely for records the API gets wrong.
 */
const { _comment: _venueOverridesComment, ...VENUE_OVERRIDES } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'venue-overrides.json'), 'utf8')
);

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

  if (stadium.city) parts.push(stadium.city);
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
 * Sidecar entry for a stadium the run never queried. Same shape as every other
 * record so the raw file stays uniform, with response/query null because no
 * request was made and the cached coordinates echoed back as what it kept.
 */
function skipRecord(stadium, countryName, league, reason) {
  return {
    teamId: stadium.teamId,
    teamName: stadium.teamName,
    venue: stadium.venue,
    city: stadium.city ?? null,
    country: countryName,
    league: league.name,
    areaCode: (stadium.area && stadium.area.code) || null,
    iso2: null,
    query: null,
    missingSegments: [],
    cachedLat: stadium.latitude ?? null,
    cachedLng: stadium.longitude ?? null,
    response: null,
    fetchError: null,
    outcome: 'skipped',
    skipReason: reason,
  };
}

/**
 * Add coordinates to all stadiums
 */
async function geocodeStadiums() {
  console.log('GEOCODING STADIUMS\n');
  console.log(`Mode:   ${APPLY ? 'APPLY (writes the real cache)' : 'DRY (candidate file only)'}`);
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
    console.error('ERROR: stadiums-premium.json not found!');
    console.error('   Run export-stadiums-proxy.js first');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  console.log(`Loaded: ${data.totalStadiums} stadiums from ${data.totalCountries} countries\n`);

  let accepted = 0;
  let overridden = 0;
  let skipped = 0;
  let geocoded = 0;
  let acceptedByType = 0;
  let acceptedByName = 0;
  const nameMatches = [];
  let rejected = 0;
  let errored = 0;
  const rejections = [];
  const rawRecords = [];

  // Set by the stadium loop when the run has to stop early (daily quota gone,
  // or MAX_REQUESTS hit). The loops unwind on it rather than throwing, so
  // control still reaches the write step below and the partial run is saved.
  let aborted = null;

  // Every stadium is re-queried, including ones that already have
  // coordinates: a rejection keeps the existing values, so a re-run can only
  // improve a record or leave it untouched.
  for (const [countryName, countryData] of Object.entries(data.countries)) {
    console.log(`\n${countryName}`);
    console.log('-'.repeat(50));

    for (const league of countryData.leagues) {
      console.log(`\n${league.name} (${league.stadiums.length} teams)`);

      for (let i = 0; i < league.stadiums.length; i++) {
        const stadium = league.stadiums[i];
        const label = `[${i + 1}/${league.stadiums.length}] ${stadium.teamName || stadium.name}`;

        // Selection runs before everything else, overrides included: a scoped
        // run must leave every record outside its scope byte-identical, and an
        // override rewrites fields. Records skipped here keep their coordinates,
        // their city, and everything else exactly as loaded.
        if (TEAM_FILTER && !TEAM_FILTER.has(stadium.teamId)) {
          skipped++;
          rawRecords.push(skipRecord(stadium, countryName, league, 'not-in-team-filter'));
          continue;
        }

        // Overrides win outright and cost no API call. Applied here, after the
        // geocoding step in pipeline order, so an override always beats a
        // geocoded value for the same record.
        const override = VENUE_OVERRIDES[stadium.teamId];
        if (override) {
          applyVenueOverride(stadium, override);
          overridden++;
          console.log(`  ${label}`);
          console.log(`    OVERRIDE - skipping geocode`);
          console.log(`      venue: ${stadium.venue}`);
          console.log(`      city:  ${stadium.city ?? '(none)'}`);
          console.log(`      coords: ${stadium.latitude}, ${stadium.longitude}`);
          console.log(`      reason: ${override.reason || '(none given)'}`);
          rawRecords.push({
            teamId: stadium.teamId,
            teamName: stadium.teamName,
            venue: stadium.venue,
            city: stadium.city ?? null,
            country: countryName,
            league: league.name,
            areaCode: (stadium.area && stadium.area.code) || null,
            iso2: null,
            query: null,
            missingSegments: [],
            cachedLat: stadium.latitude ?? null,
            cachedLng: stadium.longitude ?? null,
            response: null,
            fetchError: null,
            outcome: 'override',
            override,
          });
          continue;
        }

        // Checked after the override block on purpose: an override costs no
        // API request, so --only-missing has no reason to suppress one. Only
        // --team, which means "touch nothing else", skips overrides too.
        if (ONLY_MISSING && !TEAM_FILTER && hasValidCoordinates(stadium)) {
          skipped++;
          console.log(`  ${label}`);
          console.log(`    SKIP - already has coordinates: `
            + `${stadium.latitude}, ${stadium.longitude}`);
          rawRecords.push(skipRecord(stadium, countryName, league, 'has-coordinates'));
          continue;
        }

        const { address, missing } = buildAddress(stadium, countryName);
        const areaCode = stadium.area && stadium.area.code;
        const iso2 = AREA_CODE_TO_ISO2[areaCode] || null;

        // The stored city feeds the query only. It is dropped here so it can
        // never survive into the output; an accepted response re-derives it.
        const storedCity = stadium.city;
        delete stadium.city;

        const record = {
          teamId: stadium.teamId,
          teamName: stadium.teamName,
          venue: stadium.venue,
          city: storedCity ?? null,
          country: countryName,
          league: league.name,
          areaCode: areaCode || null,
          iso2,
          query: address,
          missingSegments: missing,
          cachedLat: stadium.latitude ?? null,
          cachedLng: stadium.longitude ?? null,
          response: null,
          fetchError: null,
          outcome: null,
        };

        geocoded++;
        console.log(`  ${label}`);
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

          const byType = !!(top && types.includes('stadium'));
          const byName = !!(top && !byType
            && venueNameMatches(stadium.venue, top.formatted_address));

          if (byType || byName) {
            stadium.latitude = top.geometry.location.lat;
            stadium.longitude = top.geometry.location.lng;

            const city = extractCity(top.address_components || []);
            if (city) {
              stadium.city = city;
            }

            record.outcome = 'accepted';
            record.acceptedBy = byType ? 'stadium-type' : 'name-match';
            accepted++;
            if (byType) acceptedByType++;
            else {
              acceptedByName++;
              nameMatches.push({
                teamName: stadium.teamName,
                venue: stadium.venue,
                country: countryName,
                formatted: top.formatted_address,
                types,
              });
            }
            console.log(`    ACCEPTED [${byType ? 'stadium type' : 'name match'}] `
              + `${stadium.latitude}, ${stadium.longitude}${city ? ` (${city})` : ''}`);
            if (byName) console.log(`      matched: ${top.formatted_address}`);
          } else {
            // A rejection must never strip a field: put the cached city back.
            if (storedCity !== undefined) {
              stadium.city = storedCity;
            }
            record.outcome = 'rejected';
            rejected++;
            const rejection = {
              teamName: stadium.teamName,
              venue: stadium.venue,
              country: countryName,
              league: league.name,
              query: address,
              status: response.status,
              formatted: top ? top.formatted_address : null,
              types,
              keptLat: stadium.latitude ?? null,
              keptLng: stadium.longitude ?? null,
            };
            rejections.push(rejection);
            console.log(`    REJECTED (${response.status})`);
            console.log(`      got:   ${top ? top.formatted_address : '(no result)'}`);
            console.log(`      types: ${types.length ? types.join(', ') : '(none)'}`);
            console.log(`      keeping cached: ${rejection.keptLat}, ${rejection.keptLng}`);
          }
        } catch (err) {
          if (err instanceof RunAborted) {
            // Not this stadium's fault: it keeps its cached values like any
            // rejection, and the run stops here.
            if (storedCity !== undefined) {
              stadium.city = storedCity;
            }
            record.fetchError = err.message;
            record.outcome = 'aborted';
            rawRecords.push(record);
            aborted = err;
            console.error(`    ABORTING RUN - ${err.message}`);
            console.log(`      keeping cached: ${stadium.latitude}, ${stadium.longitude}`);
            break;
          }
          record.fetchError = String(err.message);
          // Same as a rejection: keep whatever the cache already had.
          if (storedCity !== undefined) {
            stadium.city = storedCity;
          }
          record.outcome = 'error';
          errored++;
          rejections.push({
            teamName: stadium.teamName,
            venue: stadium.venue,
            country: countryName,
            league: league.name,
            query: address,
            status: `ERROR: ${err.message}`,
            formatted: null,
            types: [],
            keptLat: stadium.latitude ?? null,
            keptLng: stadium.longitude ?? null,
          });
          console.error(`    ERROR: ${err.message}`);
          console.log(`      keeping cached: ${stadium.latitude}, ${stadium.longitude}`);
        }

        rawRecords.push(record);
        await sleep(CALL_DELAY_MS);
      }

      if (aborted) break;
    }

    if (aborted) break;
  }

  // Update metadata
  data.lastGeocoded = new Date().toISOString().split('T')[0];
  data.geocodingStats = {
    accepted,
    acceptedByType,
    acceptedByName,
    overridden,
    rejected,
    errored,
    skipped,
    geocoded,
    total: accepted + overridden + rejected + errored,
    totalStadiums: accepted + overridden + rejected + errored + skipped,
    scope: TEAM_FILTER
      ? { mode: 'team', teamIds: [...TEAM_FILTER] }
      : { mode: ONLY_MISSING ? 'only-missing' : 'all' },
    requestsUsed: requestCount,
    requestCeiling: MAX_REQUESTS,
    aborted: aborted ? { reason: aborted.reason, message: aborted.message } : null,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  fs.writeFileSync(RAW_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    queryShape: "venue + ', ' + city + ', ' + countryName; components=country:<ISO2>",
    acceptanceRule: "results[0].types includes 'stadium'",
    mode: APPLY ? 'apply' : 'candidate',
    requestsUsed: requestCount,
    aborted: aborted ? { reason: aborted.reason, message: aborted.message } : null,
    count: rawRecords.length,
    records: rawRecords,
  }, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log(aborted ? 'GEOCODING ABORTED - PARTIAL RESULTS SAVED' : 'GEOCODING COMPLETE');
  console.log('='.repeat(60));
  console.log('Statistics:');
  console.log(`   Accepted total:                     ${accepted}`);
  console.log(`     via "stadium" type:               ${acceptedByType}`);
  console.log(`     via venue-name match:             ${acceptedByName}`);
  console.log(`   Rejected:                           ${rejected}`);
  console.log(`   Errored:                            ${errored}`);
  console.log(`   Geocoded (API request made):        ${geocoded}`);
  console.log(`   Overridden (geocode skipped):       ${overridden}`);
  console.log(`   Skipped (not selected):             ${skipped}`);
  console.log(`   Total stadiums seen:                ${accepted + overridden + rejected + errored + skipped}`);
  console.log(`   API requests used:                  ${requestCount} / ${MAX_REQUESTS}`);

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

// Check for API key
if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'YOUR_KEY_HERE') {
  console.error('ERROR: Google Maps API key not found!');
  console.error('');
  console.error('Set one of these in your environment:');
  console.error('export REACT_APP_GOOGLE_GEOCODING_KEY=your_key_here   (preferred)');
  console.error('export REACT_APP_GOOGLE_MAPS_API_KEY=your_key_here');
  console.error('');
  process.exit(1);
}

// Run geocoding
geocodeStadiums().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
