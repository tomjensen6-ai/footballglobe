// src/lib/fgApi.js

// Use Google Geocoding API directly (no CORS issues)
export async function fgReverseGeocode(lat, lng) {
  const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reverse geocode failed: ${res.status}`);
  
  const data = await res.json();
  
  if (data.status === 'OK' && data.results && data.results[0]) {
    const result = data.results[0];
    const countryComponent = result.address_components.find(c =>
      c.types.includes('country')
    );
    
    if (countryComponent) {
      return {
        lat,
        lng,
        countryCode: countryComponent.short_name,
        countryName: countryComponent.long_name
      };
    }
  }
  
  throw new Error('Reverse geocoding failed: No country found');
}

export async function fgForwardGeocode(address) {
  const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forward geocode failed: ${res.status}`);
  const data = await res.json();
  if (data.status === 'OK' && data.results[0]) {
    const location = data.results[0].geometry.location;
    return {
      lat: location.lat,
      lng: location.lng,
      countryCode: null,
      countryName: null
    };
  }
  throw new Error('Forward geocoding failed');
}

// Use the correct proxy path: /api/football
export async function fgFootball(endpoint, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `/api/football/${endpoint}?${qs.toString()}`;
  console.log(`📡 Calling proxy: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fgFootball ${endpoint} failed: ${res.status}`);
  }
  return res.json();
}