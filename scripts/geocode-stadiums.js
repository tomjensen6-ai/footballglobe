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
 * Output: stadiums-premium-candidate.json by default. Pass --apply to write
 *   stadiums-premium.json for real. Every complete API response is persisted
 *   to a sidecar JSON next to the output.
 *
 * Usage: node scripts/geocode-stadiums.js [--apply]
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

const APPLY = process.argv.includes('--apply');

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
 * Geocode an address. Resolves the COMPLETE parsed response so the caller can
 * inspect types/address_components and persist the payload verbatim.
 */
function geocodeAddress(address, iso2) {
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
 * Backoff schedule for OVER_QUERY_LIMIT, in ms. Three retries; a query that is
 * still rate-limited after the last one falls through to the caller and is
 * treated as an ordinary rejection, so the stadium keeps its cached values.
 */
const OVER_QUERY_LIMIT_BACKOFF_MS = [2000, 8000, 32000];

/**
 * Geocode with retries for OVER_QUERY_LIMIT only. Every other status - including
 * ZERO_RESULTS and REQUEST_DENIED - is returned immediately, since retrying
 * those just burns quota. Returns { response, retries }.
 */
async function geocodeWithRetry(address, iso2) {
  let response = await geocodeAddress(address, iso2);
  let retries = 0;

  for (const waitMs of OVER_QUERY_LIMIT_BACKOFF_MS) {
    if (response.status !== 'OVER_QUERY_LIMIT') break;
    retries++;
    console.log(`    OVER_QUERY_LIMIT - retry ${retries}/${OVER_QUERY_LIMIT_BACKOFF_MS.length}`
      + ` after ${waitMs / 1000}s`);
    await sleep(waitMs);
    response = await geocodeAddress(address, iso2);
  }

  return { response, retries };
}

/**
 * Add coordinates to all stadiums
 */
async function geocodeStadiums() {
  console.log('GEOCODING STADIUMS\n');
  console.log(`Mode:   ${APPLY ? 'APPLY (writes the real cache)' : 'DRY (candidate file only)'}`);
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
  let acceptedByType = 0;
  let acceptedByName = 0;
  const nameMatches = [];
  let rejected = 0;
  let errored = 0;
  const rejections = [];
  const rawRecords = [];

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
    }
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
    total: accepted + overridden + rejected + errored,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  fs.writeFileSync(RAW_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    queryShape: "venue + ', ' + city + ', ' + countryName; components=country:<ISO2>",
    acceptanceRule: "results[0].types includes 'stadium'",
    mode: APPLY ? 'apply' : 'candidate',
    count: rawRecords.length,
    records: rawRecords,
  }, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('GEOCODING COMPLETE');
  console.log('='.repeat(60));
  console.log('Statistics:');
  console.log(`   Accepted total:                     ${accepted}`);
  console.log(`     via "stadium" type:               ${acceptedByType}`);
  console.log(`     via venue-name match:             ${acceptedByName}`);
  console.log(`   Overridden (geocode skipped):       ${overridden}`);
  console.log(`   Rejected:                           ${rejected}`);
  console.log(`   Errored:                            ${errored}`);
  console.log(`   Total:                              ${accepted + overridden + rejected + errored}`);

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
