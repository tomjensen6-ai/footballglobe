/**
 * FOOTBALLGLOBE - STANDINGS CACHE EXPORT
 * 
 * Purpose: Fetch current league standings and cache them
 * Source: football-data.org via maprates-proxy
 * Output: standings-premium-cache.json
 * 
 * Run: node scripts/export-standings.js
 * Frequency: Daily (manually or via cron)
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
const CACHE_PATH = path.join(ROOT, 'standings-premium-cache.json');

// Display-name overrides, keyed by competition id. football-data returns the
// formal name; these keep the names this project has always shown. Anything
// not listed here uses the API's own name.
const COMPETITION_NAMES = {
  2014: 'La Liga',                  // API: "Primera Division"
  2013: 'Brasileiro Série A',       // API: "Campeonato Brasileiro Série A"
};

// Competitions kept regardless of type. Discovery filters to type LEAGUE;
// the Champions League is a CUP but has always been part of this export.
const ALWAYS_INCLUDE = new Set([
  2001, // UEFA Champions League
]);

// Used only if discovery fails. Preserves the ten competitions this script
// fetched before discovery existed.
const FALLBACK_COMPETITIONS = [
  { id: 2021, name: 'Premier League', country: 'England' },
  { id: 2016, name: 'Championship', country: 'England' },
  { id: 2014, name: 'La Liga', country: 'Spain' },
  { id: 2002, name: 'Bundesliga', country: 'Germany' },
  { id: 2019, name: 'Serie A', country: 'Italy' },
  { id: 2015, name: 'Ligue 1', country: 'France' },
  { id: 2003, name: 'Eredivisie', country: 'Netherlands' },
  { id: 2017, name: 'Primeira Liga', country: 'Portugal' },
  { id: 2013, name: 'Brasileiro Série A', country: 'Brazil' },
  { id: 2001, name: 'UEFA Champions League', country: 'Europe' },
];

/**
 * Fetch data from proxy
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
 * Ask the proxy which competitions the current plan actually serves. Whatever
 * comes back IS the live set - there is no separate frozen/live list to keep
 * in sync by hand any more.
 *
 * Returns { competitions, usedFallback }. Discovery failure is not fatal: the
 * run continues against FALLBACK_COMPETITIONS.
 */
async function discoverCompetitions() {
  try {
    const data = await fetchFromProxy('football-competitions');
    const all = Array.isArray(data && data.competitions) ? data.competitions : [];

    if (all.length === 0) {
      throw new Error('no competitions returned');
    }

    const competitions = all
      .filter(c => c.type === 'LEAGUE' || ALWAYS_INCLUDE.has(c.id))
      .map(c => ({
        id: c.id,
        name: COMPETITION_NAMES[c.id] ?? c.name,
        country: (c.area && c.area.name) || 'Unknown',
      }));

    if (competitions.length === 0) {
      throw new Error('discovery matched no competitions');
    }

    return { competitions, usedFallback: false };
  } catch (err) {
    console.error('');
    console.error('!'.repeat(60));
    console.error('!!  COMPETITION DISCOVERY FAILED - USING HARDCODED FALLBACK');
    console.error('!'.repeat(60));
    console.error(`!!  ${err.message}`);
    console.error(`!!  Falling back to ${FALLBACK_COMPETITIONS.length} hardcoded competitions.`);
    console.error('!!  The export will proceed, but the list may be stale.');
    console.error('!'.repeat(60));
    console.error('');
    return { competitions: FALLBACK_COMPETITIONS, usedFallback: true };
  }
}

/**
 * Process standings data
 */
function processStandings(standingsData, competitionId, competitionName, country) {
  if (!standingsData.standings || standingsData.standings.length === 0) {
    console.log('  ⚠️  No standings data available');
    return null;
  }

  // Get the main standings (usually first array element)
  const mainStandings = standingsData.standings[0];
  
  if (!mainStandings.table || mainStandings.table.length === 0) {
    console.log('  ⚠️  No table data available');
    return null;
  }

  // Extract clean standings data
  const table = mainStandings.table.map(entry => ({
    position: entry.position,
    team: {
      id: entry.team.id,
      name: entry.team.name,
      shortName: entry.team.shortName || entry.team.name,
      tla: entry.team.tla || '',
      crest: entry.team.crest || ''
    },
    playedGames: entry.playedGames,
    won: entry.won,
    draw: entry.draw,
    lost: entry.lost,
    points: entry.points,
    goalsFor: entry.goalsFor,
    goalsAgainst: entry.goalsAgainst,
    goalDifference: entry.goalDifference,
    form: entry.form || null
  }));

  console.log(`  ✅ ${table.length} teams in standings`);

  return {
    competition: {
      id: competitionId,
      name: competitionName,
      country: country,
      code: standingsData.competition?.code || '',
      emblem: standingsData.competition?.emblem || ''
    },
    season: {
      id: standingsData.season?.id,
      startDate: standingsData.season?.startDate,
      endDate: standingsData.season?.endDate,
      currentMatchday: standingsData.season?.currentMatchday
    },
    standings: {
      stage: mainStandings.stage || 'REGULAR_SEASON',
      type: mainStandings.type || 'TOTAL',
      group: mainStandings.group || null,
      table: table
    }
  };
}

/**
 * Count standings table rows across every league entry.
 *
 * The league-entry count alone cannot detect a bad run: output.leagues is
 * seeded from the existing cache and entries are only ever added or
 * overwritten, never deleted, so that count can essentially never drop. A
 * league whose table came back truncated (3 rows instead of 20) replaces a
 * full entry while leaving the league count unchanged. Rows catch that.
 */
function countTableRows(leagues) {
  let total = 0;
  for (const league of Object.values(leagues || {})) {
    total += league?.standings?.table?.length || 0;
  }
  return total;
}

/**
 * Load the existing cache's leagues, if any. Returns {} on a missing or
 * unparseable file so a first-ever run still works.
 */
function loadExistingLeagues() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.leagues === 'object' && parsed.leagues !== null) {
      return parsed.leagues;
    }
    return {};
  } catch (err) {
    return {};
  }
}

/**
 * Export all standings
 */
async function exportStandings() {
  console.log('📊 STANDINGS EXPORT\n');
  console.log('Backend:', PROXY_BASE);
  console.log('');

  const { competitions: PREMIUM_COMPETITIONS, usedFallback } = await discoverCompetitions();

  console.log('Discovered competitions:', PREMIUM_COMPETITIONS.length,
    usedFallback ? '(FALLBACK)' : '(from proxy)');
  console.log('-'.repeat(60));
  for (const comp of PREMIUM_COMPETITIONS) {
    console.log(`  ${String(comp.id).padEnd(6)} ${comp.country} - ${comp.name}`);
  }
  console.log('-'.repeat(60));
  console.log('');

  // Discovery consumed one of the 10 calls/minute.
  if (!usedFallback) {
    await sleep(CALL_DELAY_MS);
  }

  const existingLeagues = loadExistingLeagues();
  const existingCount = Object.keys(existingLeagues).length;
  const existingRows = countTableRows(existingLeagues);

  // Seed from the existing cache so a failed/frozen league keeps its last
  // known good data instead of vanishing from the output.
  const output = {
    lastUpdated: new Date().toISOString(),
    source: 'football-data.org',
    exportMethod: 'maprates-proxy',
    totalLeagues: 0,
    leagues: { ...existingLeagues }
  };

  let fetchedFresh = 0;
  let failedKept = 0;

  for (const comp of PREMIUM_COMPETITIONS) {
    const key = String(comp.id);

    console.log(`\n📋 ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));


    try {
      // Fetch standings through proxy
      const standingsData = await fetchFromProxy(`football-standings?competition=${comp.id}`);

      const processedData = processStandings(standingsData, comp.id, comp.name, comp.country);

      if (processedData) {
        processedData.capturedAt = new Date().toISOString();
        processedData.live = true;
        output.leagues[key] = processedData;
        fetchedFresh++;
      } else {
        // A null return here is expected for e.g. Champions League before
        // the league phase starts - not a fetch failure. Keep whatever is
        // cached (if anything) rather than dropping the league.
        console.log('  ℹ️  No table returned - keeping cached data');
        if (output.leagues[key]) {
          output.leagues[key].live = true;
        }
        failedKept++;
      }
    } catch (err) {
      console.error(`  ❌ ERROR: ${err.message}`);
      if (output.leagues[key]) {
        output.leagues[key].live = true;
      }
      failedKept++;
    }

    // Rate limiting - only needed when we actually made a call
    await sleep(CALL_DELAY_MS);
  }

  output.totalLeagues = Object.keys(output.leagues).length;
  const totalRows = countTableRows(output.leagues);

  // Pre-write guard: never let a bad run shrink the cache, by league count
  // OR by total table rows. On a first run existingRows is 0, so the row
  // check is inert and the league floor of 5 does the sanity work.
  const requiredMinimum = existingCount > 0 ? existingCount : 5;
  const guardFailures = [];

  if (output.totalLeagues < requiredMinimum) {
    guardFailures.push(
      `leagues: found ${output.totalLeagues}, expected at least ${requiredMinimum}`
    );
  }

  if (totalRows < existingRows) {
    guardFailures.push(
      `table rows: found ${totalRows}, existing cache has ${existingRows}` +
        ` (${existingRows - totalRows} would be lost)`
    );
  }

  if (guardFailures.length > 0) {
    console.error('\n' + '='.repeat(60));
    console.error('🛑 GUARD TRIPPED - refusing to write cache');
    console.error('='.repeat(60));
    for (const failure of guardFailures) {
      console.error(`   ${failure}`);
    }
    console.error(`   Existing cache at ${CACHE_PATH} left untouched.`);
    console.error('');
    process.exit(1);
  }

  // Save to file
  fs.writeFileSync(CACHE_PATH, JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 STANDINGS EXPORT COMPLETE!');
  console.log('='.repeat(60));
  console.log('📊 Summary:');
  console.log(`   Fetched fresh:   ${fetchedFresh}`);
  console.log(`   Failed (cached): ${failedKept}`);
  console.log(`   Total in file:   ${output.totalLeagues} leagues (was ${existingCount})`);
  console.log(`   Table rows:      ${totalRows} (was ${existingRows})`);
  console.log(`   Last updated:    ${output.lastUpdated}`);
  console.log(`\n📁 Saved to: ${CACHE_PATH}`);
  console.log('');
}

// Run export
exportStandings().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});
