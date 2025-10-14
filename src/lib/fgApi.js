const BASE = process.env.REACT_APP_FG_API_BASE;

export async function fgReverseGeocode(lat, lng) {
  const r = await fetch(`${BASE}/revgeocode?lat=${lat}&lng=${lng}`);
  if (!r.ok) throw new Error(`revgeocode failed ${r.status}`);
  return r.json();
}

export async function fgForwardGeocode(address) {
  const r = await fetch(`${BASE}/geocode?address=${encodeURIComponent(address)}`);
  if (!r.ok) throw new Error(`geocode failed ${r.status}`);
  
  const data = await r.json();
  
  // Transform backend format to Google format that App.js expects
  return {
    status: 'OK',
    results: [{
      geometry: {
        location: {
          lat: data.lat,
          lng: data.lng
        }
      },
      address_components: [
        {
          types: ['country'],
          short_name: data.countryCode,
          long_name: data.countryName
        }
      ]
    }]
  };
}

export async function fgFootball(endpoint, params = {}) {
  // Handle dynamic paths like "competitions/2021/teams"
  let fileName;
  
  if (endpoint.includes('/')) {
    // Dynamic path with ID - extract the base endpoint
    const parts = endpoint.split('/');
    const baseEndpoint = parts[0]; // "competitions"
    const id = parts[1]; // "2021"
    const subEndpoint = parts[2]; // "teams"
    
    if (baseEndpoint === 'competitions' && subEndpoint === 'teams') {
      fileName = 'football-teams';
      // Add competition ID to params
      params = { ...params, competition: id };
    } else {
      throw new Error(`Unknown dynamic endpoint: ${endpoint}`);
    }
  } else {
    // Simple endpoint
    const endpointMap = {
      'countries': 'football-countries',
      'leagues': 'football-leagues',
      'competitions': 'football-competitions',
      'teams': 'football-teams'
    };
    
    fileName = endpointMap[endpoint];
    if (!fileName) {
      throw new Error(`Unknown endpoint: ${endpoint}`);
    }
  }
  
  const qs = new URLSearchParams(params);
  const url = `${BASE}/${fileName}?${qs.toString()}`;
  
  console.log(`📡 Calling proxy: ${url}`);
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
  return res.json();
}
export async function fgFootballTeams(competitionId) {
  const url = `${BASE}/football-teams?competition=${competitionId}`;
  console.log(`📡 Calling proxy: ${url}`);
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`teams failed: ${res.status}`);
  return res.json();
}

export async function fgFootballStandings(competitionId) {
  // ... existing code
}
export async function fgFootballStandings(competitionId) {
  const url = `${BASE}/football-standings?competition=${competitionId}`;
  console.log(`📡 Calling proxy: ${url}`);
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`standings failed: ${res.status}`);
  return res.json();
}