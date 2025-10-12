// /api/football/[endpoint].js
export default async function handler(req, res) {
  const { endpoint, ...params } = req.query;
  
  const apiKey = process.env.API_SPORTS_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing API_SPORTS_KEY' });
  }

  const allowed = new Set(['countries', 'leagues', 'venues', 'teams', 'standings']);
  if (!allowed.has(endpoint)) {
    return res.status(400).json({ error: 'Unsupported endpoint' });
  }

  const qs = new URLSearchParams(params);
  const url = `https://v3.football.api-sports.io/${endpoint}?${qs.toString()}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'x-apisports-key': apiKey }
    });
    
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Proxy error', detail: String(e) });
  }
}