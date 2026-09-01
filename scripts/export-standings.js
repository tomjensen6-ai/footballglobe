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

// Your existing backend proxy
const PROXY_BASE = 'https://maprates-proxy.vercel.app/api/fg';

// Delay between fetches, in ms. football-data.org's free tier allows 10
// calls/minute, so anything under ~6000ms risks a 429; 6500ms leaves margin.
// Switch to 1100 if/when this runs on a paid tier (much higher ceiling).
const CALL_DELAY_MS = 6500; // free tier: 10 calls/min. Paid tier: 1100.

const CACHE_PATH = './standings-premium-cache.json';

// Premium competitions (same as stadium export)
const PREMIUM_COMPETITIONS = [
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

// Competition ids currently accessible on this subscription. Anything in
// PREMIUM_COMPETITIONS but not here is "frozen" - we leave its cached entry
// untouched instead of attempting (and failing) to fetch it.
const LIVE_COMPETITIONS = new Set([
  2021, 2016, 2014, 2002, 2019, 2015, 2003, 2017, 2013, 2001
]);

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
  console.log('Competitions:', PREMIUM_COMPETITIONS.length);
  console.log('');

  const existingLeagues = loadExistingLeagues();
  const existingCount = Object.keys(existingLeagues).length;

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
  let keptFrozen = 0;
  let failedKept = 0;

  for (const comp of PREMIUM_COMPETITIONS) {
    const key = String(comp.id);
    const isLive = LIVE_COMPETITIONS.has(comp.id);

    console.log(`\n📋 ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));

    if (!isLive) {
      console.log('  ⏸️  Skipped (frozen - not on current subscription)');
      if (output.leagues[key]) {
        output.leagues[key].live = false;
      }
      keptFrozen++;
      continue;
    }

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

  // Pre-write guard: never let a bad run shrink the cache.
  const requiredMinimum = existingCount > 0 ? existingCount : 5;
  if (output.totalLeagues < requiredMinimum) {
    console.error('\n' + '='.repeat(60));
    console.error('🛑 GUARD TRIPPED - refusing to write cache');
    console.error('='.repeat(60));
    console.error(`   Found: ${output.totalLeagues} leagues`);
    console.error(`   Expected at least: ${requiredMinimum}`);
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
  console.log(`   Kept frozen:     ${keptFrozen}`);
  console.log(`   Failed (cached): ${failedKept}`);
  console.log(`   Total in file:   ${output.totalLeagues}`);
  console.log(`   Last updated:    ${output.lastUpdated}`);
  console.log(`\n📁 Saved to: ${CACHE_PATH}`);
  console.log('');
}

// Run export
exportStandings().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});
