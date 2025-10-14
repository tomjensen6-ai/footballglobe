const BASE = process.env.REACT_APP_FG_API_BASE;

export async function fgReverseGeocode(lat, lng) {
  const r = await fetch(`${BASE}/revgeocode?lat=${lat}&lng=${lng}`);
  if (!r.ok) throw new Error(`revgeocode failed ${r.status}`);
  return r.json();
}

export async function fgForwardGeocode(address) {
  const r = await fetch(`${BASE}/geocode?address=${encodeURIComponent(address)}`);
  if (!r.ok) throw new Error(`geocode failed ${r.status}`);
  return r.json();
}

export async function fgFootball(endpoint, params = {}) {
  const endpointMap = {
    'countries': 'football-countries',
    'leagues': 'football-leagues',
    'teams': 'football-teams',
    'competitions': 'football-competitions'  // ← MUST HAVE THIS LINE
  };
  
  const fileName = endpointMap[endpoint];
  if (!fileName) {
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }
  
  const qs = new URLSearchParams(params);
  const url = `${BASE}/${fileName}?${qs.toString()}`;
  
  console.log(`📡 Calling proxy: ${url}`);
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
  return res.json();
}