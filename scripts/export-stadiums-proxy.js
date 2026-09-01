/**
 * FOOTBALLGLOBE - STADIUM EXPORT (PROXY VERSION)
 *
 * Simpler alternative: Uses your existing maprates-proxy backend
 * No need to handle API tokens directly - the proxy does it
 *
 * Run: node scripts/export-stadiums-proxy.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Your existing backend proxy
const PROXY_BASE = 'https://maprates-proxy.vercel.app/api/fg';

// Delay between fetches, in ms. football-data.org's free tier allows 10
// calls/minute, so anything under ~6000ms risks a 429; 6500ms leaves margin.
// Switch to 1100 if/when this runs on a paid tier (much higher ceiling).
const CALL_DELAY_MS = 6500; // free tier: 10 calls/min. Paid tier: 1100.

// Resolved from __dirname so the script writes the repo-root cache no matter
// which directory it is run from.
const ROOT = path.join(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'stadiums-premium.json');

// Manual corrections for venues football-data.org hasn't updated yet, keyed by teamId
const { _comment: _venueOverridesComment, ...VENUE_OVERRIDES } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'venue-overrides.json'), 'utf8')
);

/**
 * Apply a manual venue override to a stadium record, if one exists for its teamId
 */
function applyVenueOverride(stadium) {
  const override = VENUE_OVERRIDES[stadium.teamId];
  if (!override) return stadium;

  console.log(`   🔧 OVERRIDE: ${stadium.teamName} venue → "${override.venue}" (${override.reason})`);

  const venue = override.venue || stadium.venue;
  const address = override.address || stadium.address;
  const latitude = override.latitude ?? stadium.latitude;
  const longitude = override.longitude ?? stadium.longitude;

  return {
    ...stadium,
    venue,
    address,
    fullAddress: `${venue}, ${address}`,
    latitude,
    longitude
  };
}

// Premium competitions to export (tier: 1 = top flight, 2 = second division, etc.)
const PREMIUM_COMPETITIONS = [
  { id: 2021, name: 'Premier League', country: 'England', tier: 1 },
  { id: 2016, name: 'Championship', country: 'England', tier: 2 },
  { id: 2014, name: 'La Liga', country: 'Spain', tier: 1 },
  { id: 2002, name: 'Bundesliga', country: 'Germany', tier: 1 },
  { id: 2019, name: 'Serie A', country: 'Italy', tier: 1 },
  { id: 2015, name: 'Ligue 1', country: 'France', tier: 1 },
  { id: 2003, name: 'Eredivisie', country: 'Netherlands', tier: 1 },
  { id: 2017, name: 'Primeira Liga', country: 'Portugal', tier: 1 },
  { id: 2013, name: 'Brasileiro Série A', country: 'Brazil', tier: 1 },
  { id: 2001, name: 'UEFA Champions League', country: 'Europe', tier: 1 },
];

/**
 * Fetch data from your existing proxy
 */
function fetchFromProxy(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${PROXY_BASE}/${endpoint}`;
    console.log(`📡 Fetching: ${url}`);

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`JSON parse error: ${err.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Sleep for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load the existing cache, if any. Returns null on a missing or
 * unparseable file so a first-ever run still works.
 */
function loadExistingCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.countries === 'object' && parsed.countries !== null) {
      return parsed;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Derive the current season string (e.g. "2025-2026") from today's date.
 * Northern-hemisphere leagues roll over their season in July.
 */
function computeSeasonFromDate(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 6 ? year : year - 1; // month is 0-indexed; 6 = July
  return `${startYear}-${startYear + 1}`;
}

/**
 * Derive a season string from a football-data.org season object, if present.
 */
function seasonFromApiResponse(teamsData) {
  const startDate = teamsData?.season?.startDate;
  if (!startDate) return null;
  const startYear = new Date(startDate).getFullYear();
  if (Number.isNaN(startYear)) return null;
  return `${startYear}-${startYear + 1}`;
}

/**
 * Count stadiums actually present in a countries object, ignoring whatever
 * a totalStadiums field claims - used to validate the existing cache before
 * trusting it as the pre-write guard's floor.
 */
function countStadiums(countries) {
  let total = 0;
  for (const country of Object.values(countries || {})) {
    for (const league of country.leagues || []) {
      total += (league.stadiums || []).length;
    }
  }
  return total;
}

/**
 * Insert or replace a single league's entry within output.countries,
 * merging at league level so a partial failure elsewhere doesn't wipe
 * a country's other leagues.
 */
function upsertLeague(output, comp, stadiums) {
  if (!output.countries[comp.country]) {
    output.countries[comp.country] = {
      name: comp.country,
      code: comp.country.substring(0, 3).toUpperCase(),
      leagues: []
    };
  }

  const country = output.countries[comp.country];
  const leagueEntry = { id: comp.id, name: comp.name, tier: comp.tier, stadiums };
  const idx = country.leagues.findIndex(l => l.id === comp.id);

  if (idx >= 0) {
    country.leagues[idx] = leagueEntry;
  } else {
    country.leagues.push(leagueEntry);
  }
}

/**
 * Export stadiums using proxy
 */
async function exportStadiums() {
  console.log('🏟️  STADIUM EXPORT (Using Proxy)\n');
  console.log('Backend:', PROXY_BASE);
  console.log('Competitions:', PREMIUM_COMPETITIONS.length);
  console.log('');

  const existing = loadExistingCache();
  const hadExistingCache = existing !== null;
  // The stored totalStadiums field can be stale or wrong; take whichever of
  // it and an actual recount is higher, so a bad field can't weaken the guard.
  const existingStatedTotal = typeof existing?.totalStadiums === 'number' ? existing.totalStadiums : 0;
  const existingRecountedTotal = countStadiums(existing?.countries);
  const existingTotalStadiums = Math.max(existingStatedTotal, existingRecountedTotal);
  const tierById = new Map(PREMIUM_COMPETITIONS.map(c => [c.id, c.tier]));

  // Build a teamId -> geocoded-fields lookup from the existing cache so
  // stadiums that were already geocoded don't get reset on every run.
  // Mirrors exactly what geocode-stadiums.js writes onto a stadium record:
  // latitude, longitude, and (when resolved) city.
  const coordsByTeamId = new Map();
  for (const countryData of Object.values(existing?.countries || {})) {
    for (const league of countryData.leagues || []) {
      for (const stadium of league.stadiums || []) {
        if (stadium.teamId != null && stadium.latitude != null && stadium.longitude != null) {
          coordsByTeamId.set(stadium.teamId, {
            latitude: stadium.latitude,
            longitude: stadium.longitude,
            city: stadium.city
          });
        }
      }
    }
  }

  const output = {
    lastUpdated: new Date().toISOString().split('T')[0],
    season: computeSeasonFromDate(),
    source: 'football-data.org',
    exportMethod: 'maprates-proxy',
    totalCountries: 0,
    totalLeagues: 0,
    totalStadiums: 0,
    countries: {}
  };

  // Seed from the existing cache so a failed/skipped league keeps its
  // previous stadiums instead of vanishing from the output. Backfill tier
  // for cache entries written before the tier field existed.
  for (const [countryName, countryData] of Object.entries(existing?.countries || {})) {
    output.countries[countryName] = {
      name: countryData.name || countryName,
      code: countryData.code || countryName.substring(0, 3).toUpperCase(),
      leagues: (countryData.leagues || []).map(league => ({
        ...league,
        tier: league.tier ?? tierById.get(league.id) ?? 99
      }))
    };
  }

  let fetchedFresh = 0;
  let keptFromCache = 0;

  for (const comp of PREMIUM_COMPETITIONS) {
    console.log(`\n📋 ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));

    let succeeded = false;

    try {
      // Fetch teams through your proxy
      const teamsData = await fetchFromProxy(`football-teams?competition=${comp.id}`);

      // The proxy returns the data structure from football-data.org
      const teams = teamsData.teams || [];
      console.log(`Found ${teams.length} teams`);

      if (teams.length === 0) {
        console.log('⚠️  No teams returned - keeping cached data for this league');
      } else {
        const apiSeason = seasonFromApiResponse(teamsData);
        if (apiSeason) {
          output.season = apiSeason;
        }

        // Extract stadium data from teams
        const stadiums = teams.map(team => {
          // Build full address for geocoding
          let fullAddress = '';
          if (team.venue && team.venue !== 'Unknown') {
            fullAddress = team.venue;
            if (team.address) {
              fullAddress += ', ' + team.address;
            }
          } else if (team.address) {
            fullAddress = team.address;
          }

          const cachedCoords = coordsByTeamId.get(team.id);

          const stadium = {
            teamId: team.id,
            teamName: team.name,
            shortName: team.shortName || team.name,
            tla: team.tla || '',
            venue: team.venue || 'Unknown',
            address: team.address || '',
            fullAddress: fullAddress || `${team.name}, ${comp.country}`,
            // Carried forward from the previous cache when already geocoded;
            // genuinely new stadiums stay null/unset until geocode-stadiums.js
            // runs. city is only set when the cache had one (JSON.stringify
            // drops the undefined key, matching geocode-stadiums.js's own
            // conditional write).
            latitude: cachedCoords ? cachedCoords.latitude : null,
            longitude: cachedCoords ? cachedCoords.longitude : null,
            city: cachedCoords?.city,
            clubColors: team.clubColors || '',
            website: team.website || '',
            founded: team.founded || null,
            crestUrl: team.crest || '',
            area: team.area ? {
              name: team.area.name,
              code: team.area.code,
              flag: team.area.flag
            } : null
          };

          return applyVenueOverride(stadium);
        });

        upsertLeague(output, comp, stadiums);
        fetchedFresh++;
        succeeded = true;

        console.log(`✅ Completed: ${stadiums.length} stadiums`);
      }
    } catch (err) {
      console.error(`❌ ERROR: ${err.message}`);
    }

    if (!succeeded) {
      keptFromCache++;
    }

    // Rate limiting - runs even on failure, since a failed request still
    // consumed one of the 10/minute.
    await sleep(CALL_DELAY_MS);
  }

  // Sort each country's leagues by tier ascending (App.js uses leagues[0] as
  // the default selected league) and recompute totals from the final,
  // merged structure.
  let withCoords = 0;
  let needingGeocode = 0;

  for (const country of Object.values(output.countries)) {
    country.leagues.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));

    if (country.leagues.length > 0) {
      output.totalCountries++;
    }

    for (const league of country.leagues) {
      output.totalLeagues++;
      output.totalStadiums += league.stadiums.length;

      for (const stadium of league.stadiums) {
        if (stadium.latitude != null && stadium.longitude != null) {
          withCoords++;
        } else {
          needingGeocode++;
        }
      }
    }
  }

  // Pre-write guard: never let a bad run shrink the cache.
  const requiredMinimumStadiums = hadExistingCache ? existingTotalStadiums : 100;
  if (output.totalCountries === 0 || output.totalStadiums < requiredMinimumStadiums) {
    console.error('\n' + '='.repeat(60));
    console.error('🛑 GUARD TRIPPED - refusing to write cache');
    console.error('='.repeat(60));
    console.error(`   Found: ${output.totalStadiums} stadiums in ${output.totalCountries} countries`);
    console.error(`   Expected at least: ${requiredMinimumStadiums} stadiums, >0 countries`);
    console.error(`   Existing cache at ${CACHE_PATH} left untouched.`);
    console.error('');
    process.exit(1);
  }

  // Save to file
  fs.writeFileSync(CACHE_PATH, JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 EXPORT COMPLETE!');
  console.log('='.repeat(60));
  console.log('📊 Summary:');
  console.log(`   Leagues fetched fresh:  ${fetchedFresh}`);
  console.log(`   Leagues kept from cache: ${keptFromCache}`);
  console.log(`   Stadiums with coordinates: ${withCoords}`);
  console.log(`   Stadiums needing geocoding: ${needingGeocode}`);
  console.log(`   Countries: ${output.totalCountries}`);
  console.log(`   Leagues: ${output.totalLeagues}`);
  console.log(`   Stadiums: ${output.totalStadiums}`);
  console.log(`\n📁 Saved to: ${CACHE_PATH}`);
  console.log('');
}

// Run export
exportStadiums().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});
