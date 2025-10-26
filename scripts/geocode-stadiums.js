/**
 * FOOTBALLGLOBE - GEOCODING SCRIPT
 * 
 * Adds latitude/longitude to stadiums-premium.json
 * Run AFTER export-stadiums-proxy.js
 * 
 * Usage: node scripts/geocode-stadiums.js
 */

const fs = require('fs');
const https = require('https');

// Read Google API key from environment
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || 'YOUR_KEY_HERE';

/**
 * Geocode an address using Google Maps
 */
function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_API_KEY}`;

    https.get(url, (res) => {
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
            console.log(`    ⚠️  Geocode failed: ${result.status}`);
            resolve(null);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
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
 * Add coordinates to all stadiums
 */
async function geocodeStadiums() {
  console.log('🗺️  GEOCODING STADIUMS\n');

  // Read existing JSON
  const inputPath = './stadiums-premium.json';
  if (!fs.existsSync(inputPath)) {
    console.error('❌ ERROR: stadiums-premium.json not found!');
    console.error('   Run export-stadiums-proxy.js first');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  console.log(`📊 Loaded: ${data.totalStadiums} stadiums from ${data.totalCountries} countries\n`);

  let geocoded = 0;
  let skipped = 0;
  let failed = 0;

  // Process each country
  for (const [countryName, countryData] of Object.entries(data.countries)) {
    console.log(`\n🌍 ${countryName}`);
    console.log('─'.repeat(50));

    for (const league of countryData.leagues) {
      console.log(`\n📋 ${league.name} (${league.stadiums.length} teams)`);

      for (let i = 0; i < league.stadiums.length; i++) {
        const stadium = league.stadiums[i];
        
        // Skip if already has coordinates
        if (stadium.latitude && stadium.longitude) {
          console.log(`  [${i + 1}/${league.stadiums.length}] ✓ ${stadium.teamName || stadium.name} (already geocoded)`);
          skipped++;
          continue;
        }

        // Use the fullAddress from export, or build one
        let address = stadium.fullAddress || '';
        if (!address) {
          if (stadium.venue && stadium.venue !== 'Unknown') {
            address = stadium.venue;
            if (stadium.address) {
              address += ', ' + stadium.address;
            } else {
              address += ', ' + countryName;
            }
          } else {
            address = `${stadium.teamName}, ${countryName}`;
          }
        }

        console.log(`  [${i + 1}/${league.stadiums.length}] 🔍 ${stadium.teamName || stadium.name}`);
        console.log(`    Venue: ${stadium.venue}`);
        console.log(`    Address: ${address}`);

        try {
          const coords = await geocodeAddress(address);
          
          if (coords) {
            stadium.latitude = coords.lat;
            stadium.longitude = coords.lng;
            console.log(`    ✅ Found: ${coords.lat}, ${coords.lng}`);
            geocoded++;
          } else {
            console.log(`    ❌ Failed to geocode`);
            failed++;
          }

          // Rate limiting: 200ms between requests
          await sleep(200);

        } catch (err) {
          console.error(`    ❌ Error: ${err.message}`);
          failed++;
        }
      }
    }
  }

  // Update metadata
  data.lastGeocoded = new Date().toISOString().split('T')[0];
  data.geocodingStats = {
    successful: geocoded,
    skipped: skipped,
    failed: failed,
    total: data.totalStadiums
  };

  // Save updated JSON
  const outputPath = './stadiums-premium-geocoded.json';
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

  // Also overwrite original
  fs.writeFileSync(inputPath, JSON.stringify(data, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 GEOCODING COMPLETE!');
  console.log('='.repeat(60));
  console.log(`📊 Statistics:`);
  console.log(`   Successfully geocoded: ${geocoded}`);
  console.log(`   Already had coordinates: ${skipped}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total stadiums: ${data.totalStadiums}`);
  console.log(`\n📁 Saved to:`);
  console.log(`   ${inputPath} (updated)`);
  console.log(`   ${outputPath} (backup)`);
  console.log('');
}

// Check for API key
if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'YOUR_KEY_HERE') {
  console.error('❌ ERROR: Google Maps API key not found!');
  console.error('');
  console.error('Set it in your environment:');
  console.error('export REACT_APP_GOOGLE_MAPS_API_KEY=your_key_here');
  console.error('');
  console.error('Or edit this script and set GOOGLE_API_KEY directly');
  process.exit(1);
}

// Run geocoding
geocodeStadiums().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});