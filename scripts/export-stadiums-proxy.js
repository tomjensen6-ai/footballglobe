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

// Your existing backend proxy
const PROXY_BASE = 'https://maprates-proxy.vercel.app/api/fg';

// Premium competitions to export
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
 * Export stadiums using proxy
 */
async function exportStadiums() {
  console.log('🏟️  STADIUM EXPORT (Using Proxy)\n');
  console.log('Backend:', PROXY_BASE);
  console.log('Competitions:', PREMIUM_COMPETITIONS.length);
  console.log('');

  const output = {
    lastUpdated: new Date().toISOString().split('T')[0],
    season: '2024-2025',
    source: 'football-data.org',
    exportMethod: 'maprates-proxy',
    totalCountries: 0,
    totalLeagues: 0,
    totalStadiums: 0,
    countries: {}
  };

  for (const comp of PREMIUM_COMPETITIONS) {
    console.log(`\n📋 ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));

    try {
      // Fetch teams through your proxy
      const teamsData = await fetchFromProxy(`football-teams?competition=${comp.id}`);
      
      // The proxy returns the data structure from football-data.org
      const teams = teamsData.teams || [];
      console.log(`Found ${teams.length} teams`);
      
      if (teams.length === 0) {
        console.log('⚠️  No teams returned - skipping');
        continue;
      }

      // Initialize country if needed
      if (!output.countries[comp.country]) {
        output.countries[comp.country] = {
          name: comp.country,
          code: comp.country.substring(0, 3).toUpperCase(),
          leagues: []
        };
        output.totalCountries++;
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
        
        return {
          teamId: team.id,
          teamName: team.name,
          shortName: team.shortName || team.name,
          tla: team.tla || '',
          venue: team.venue || 'Unknown',
          address: team.address || '',
          fullAddress: fullAddress || `${team.name}, ${comp.country}`,
          // Coordinates will be added by geocoding script
          latitude: null,
          longitude: null,
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
      });

      // Add to output
      output.countries[comp.country].leagues.push({
        id: comp.id,
        name: comp.name,
        stadiums: stadiums
      });

      output.totalLeagues++;
      output.totalStadiums += stadiums.length;

      console.log(`✅ Completed: ${stadiums.length} stadiums`);

      // Rate limiting
      await sleep(1000);

    } catch (err) {
      console.error(`❌ ERROR: ${err.message}`);
    }
  }

  // Save to file
  const outputPath = './stadiums-premium.json';
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 EXPORT COMPLETE!');
  console.log('='.repeat(60));
  console.log(`📊 Statistics:`);
  console.log(`   Countries: ${output.totalCountries}`);
  console.log(`   Leagues: ${output.totalLeagues}`);
  console.log(`   Stadiums: ${output.totalStadiums}`);
  console.log(`\n📁 Saved to: ${outputPath}`);
  console.log('');
  console.log('⚠️  NOTE: Coordinates are null - we need to geocode separately');
  console.log('   We can either:');
  console.log('   1. Add geocoding to this script (needs Google API key)');
  console.log('   2. Geocode on-demand in the frontend (first time only)');
  console.log('   3. Run a separate geocoding script');
  console.log('');
}

// Run export
exportStadiums().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});