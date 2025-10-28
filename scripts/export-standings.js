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
 * Export all standings
 */
async function exportStandings() {
  console.log('📊 STANDINGS EXPORT\n');
  console.log('Backend:', PROXY_BASE);
  console.log('Competitions:', PREMIUM_COMPETITIONS.length);
  console.log('');

  const output = {
    lastUpdated: new Date().toISOString(),
    source: 'football-data.org',
    exportMethod: 'maprates-proxy',
    totalLeagues: 0,
    leagues: {}
  };

  for (const comp of PREMIUM_COMPETITIONS) {
    console.log(`\n📋 ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));

    try {
      // Fetch standings through proxy
      const standingsData = await fetchFromProxy(`football-standings?competition=${comp.id}`);
      
      const processedData = processStandings(standingsData, comp.id, comp.name, comp.country);
      
      if (processedData) {
        output.leagues[comp.id] = processedData;
        output.totalLeagues++;
      }

      // Rate limiting
      await sleep(1000);

    } catch (err) {
      console.error(`  ❌ ERROR: ${err.message}`);
    }
  }

  // Save to file
  const outputPath = './standings-premium-cache.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 STANDINGS EXPORT COMPLETE!');
  console.log('='.repeat(60));
  console.log(`📊 Statistics:`);
  console.log(`   Leagues fetched: ${output.totalLeagues}/${PREMIUM_COMPETITIONS.length}`);
  console.log(`   Last updated: ${output.lastUpdated}`);
  console.log(`\n📁 Saved to: ${outputPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Verify the standings data');
  console.log('2. Set up daily automatic updates (Week 2 Day 2)');
  console.log('3. Integrate into React app (Week 3)');
  console.log('');
}

// Run export
exportStandings().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});