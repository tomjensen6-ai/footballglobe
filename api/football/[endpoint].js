// api/football/[endpoint].js
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint, ...params } = req.query;
  const apiToken = process.env.FOOTBALL_DATA_API_TOKEN;
  
  console.log('🔑 FOOTBALL_DATA_API_TOKEN exists?', !!apiToken);
  
  if (!apiToken) {
    return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_TOKEN' });
  }

  // Map your endpoints to Football-Data.org endpoints
  const endpointMap = {
    'competitions': 'competitions',
    'teams': 'teams',
    'matches': 'matches',
    'standings': 'standings'
  };

  const mappedEndpoint = endpointMap[endpoint];
  
  if (!mappedEndpoint) {
    return res.status(400).json({ error: `Unsupported endpoint: ${endpoint}` });
  }

  // Build the URL
  const qs = new URLSearchParams(params);
  const queryString = qs.toString() ? `?${qs.toString()}` : '';
  const url = `https://api.football-data.org/v4/${mappedEndpoint}${queryString}`;

  console.log('🌐 Proxying request to:', url);

  try {
    const upstream = await fetch(url, {
      headers: { 
        'X-Auth-Token': apiToken
      }
    });
    
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('❌ Proxy error:', e);
    return res.status(502).json({ error: 'Proxy error', detail: String(e) });
  }
}
