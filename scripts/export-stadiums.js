/**
 * FOOTBALLGLOBE - STADIUM DATA EXPORT SCRIPT
 * 
 * Purpose: One-time export to create stadiums-premium.json
 * Source: football-data.org API (direct call with your token)
 * Output: Static JSON file for instant loading
 * 
 * Run once locally on Mac mini, test, then commit to GitHub
 */

const fs = require('fs');
const https = require('https');

// Your football-data.org API token
// Get from: /Users/tje/projects/footballglobe/.env
const FOOTBALL_API_TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || 'YOUR_TOKEN_HERE';

// Premium competitions to export
const PREMIUM_COMPETITIONS = [
  { id: 2021, name: 'Premier League', country: 'England' },
  { id: 2014, name: 'La Liga', country: 'Spain' },
  { id: 2002, name: 'Bundesliga', country: 'Germany' },
  { id: 2019, name: 'Serie A', country: 'Italy' },
  { id: 2015, name: 'Ligue 1', country: 'France' },
  { id: 2003, name: 'Eredivisie', country: 'Netherlands' },
  { id: 2017, name: 'Primeira Liga', country: 'Portugal' },
  { id: 2013, name: 'Brasileiro Série A', country: 'Brazil' },
  { id: 2021, name: 'Primera División', country: 'Argentina' }, // Note: Verify this ID
  { id: 2001, name: 'UEFA Champions League', country: 'Europe' },
];

// Google Maps API key for geocoding (if needed)
const GOOGLE_MAPS_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_KEY_HERE';

/**
 * Make HTTP request to football-data.org API
 */
function fetchFootballData(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path: `/v4/${path}`,
      method: 'GET',
      headers: {
        'X-Auth-Token': FOOTBALL_API_TOKEN
      }
    };

    console.log(`📡 Fetching: ${path}`);

    https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
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
 * Geocode an address using Google Maps API
 */
function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const encodedAddress = encodeURIComponent(address);
    const options = {
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${encodedAddress}&key=${GOOGLE_MAPS_API_KEY}`,
      method: 'GET'
    };

    https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          const result = JSON.parse(data);
          if (result.status === 'OK' && result.results.length > 0) {
            const location = result.results[0].geometry.location;
            resolve({ lat: location.lat, lng: location.lng });
          } else {
            resolve(null); // Geocoding failed
          }
        } else {
          reject(new Error(`Geocode failed: ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Sleep function for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single team and extract stadium data
 */
async function processTeam(team, competitionId, competitionName, country) {
  const stadium = {
    id: team.id,
    name: team.name,
    shortName: team.shortName || team.name,
    tla: team.tla || '',
    venue: team.venue || 'Unknown',
    address: team.address || '',
    latitude: null,
    longitude: null,
    clubColors: team.clubColors || '',
    website: team.website || '',
    founded: team.founded || null,
    crestUrl: team.crest || ''
  };

  // Try to geocode if we have venue info
  if (team.venue && team.venue !== 'Unknown') {
    try {
      const fullAddress = `${team.venue}, ${team.address || country}`;
      console.log(`  🗺️  Geocoding: ${fullAddress}`);
      
      const coords = await geocodeAddress(fullAddress);
      if (coords) {
        stadium.latitude = coords.lat;
        stadium.longitude = coords.lng;
        console.log(`  ✅ Found: ${coords.lat}, ${coords.lng}`);
      } else {
        console.log(`  ⚠️  Geocoding failed for ${team.name}`);
      }
      
      // Rate limiting: wait 200ms between geocoding requests
      await sleep(200);
    } catch (err) {
      console.error(`  ❌ Geocoding error for ${team.name}:`, err.message);
    }
  }

  return stadium;
}

/**
 * Export all premium league stadiums
 */
async function exportStadiums() {
  console.log('🏟️  STARTING STADIUM EXPORT\n');
  console.log('Premium Competitions:', PREMIUM_COMPETITIONS.length);
  console.log('');

  const output = {
    lastUpdated: new Date().toISOString().split('T')[0],
    season: '2024-2025',
    source: 'football-data.org',
    totalCountries: 0,
    totalLeagues: 0,
    totalStadiums: 0,
    countries: {}
  };

  for (const comp of PREMIUM_COMPETITIONS) {
    console.log(`\n📋 Processing: ${comp.name} (${comp.country})`);
    console.log('─'.repeat(50));

    try {
      // Fetch teams for this competition
      const teamsData = await fetchFootballData(`competitions/${comp.id}/teams`);
      const teams = teamsData.teams || [];

      console.log(`Found ${teams.length} teams`);

      // Initialize country structure if needed
      if (!output.countries[comp.country]) {
        output.countries[comp.country] = {
          name: comp.country,
          leagues: []
        };
        output.totalCountries++;
      }

      // Process each team
      const stadiums = [];
      for (let i = 0; i < teams.length; i++) {
        const team = teams[i];
        console.log(`\n[${i + 1}/${teams.length}] ${team.name}`);
        
        const stadium = await processTeam(team, comp.id, comp.name, comp.country);
        stadiums.push(stadium);
      }

      // Add league to country
      output.countries[comp.country].leagues.push({
        id: comp.id,
        name: comp.name,
        stadiums: stadiums
      });

      output.totalLeagues++;
      output.totalStadiums += stadiums.length;

      console.log(`\n✅ Completed: ${comp.name} - ${stadiums.length} stadiums`);

      // Rate limiting between competitions
      await sleep(1000);

    } catch (err) {
      console.error(`\n❌ ERROR processing ${comp.name}:`, err.message);
      console.error('Continuing with next competition...\n');
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
  console.log('Next steps:');
  console.log('1. Review the JSON file');
  console.log('2. Test loading it in your app');
  console.log('3. Push to GitHub after testing');
  console.log('');
}

// Run the export
exportStadiums().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});