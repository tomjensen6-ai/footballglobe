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
export async function fgFootball(path, query) {
  const qs = new URLSearchParams(query);
  const url = `/fg/football?path=${encodeURIComponent(path)}&${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fgFootball ${path} failed`);
  return res.json();
}
