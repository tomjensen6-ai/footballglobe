// api/football/[...path].js
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract path segments
  const { path: pathSegments, ...params } = req.query;
  const apiToken = process.env.FOOTBALL_DATA_API_TOKEN;
  
  console.log('🔑 FOOTBALL_DATA_API_TOKEN exists?', !!apiToken);
  console.log('📍 Path segments:', pathSegments);
  
  if (!apiToken) {
    return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_TOKEN' });
  }

  if (!pathSegments || pathSegments.length === 0) {
    return res.status(400).json({ error: 'No path provided' });
  }

  // Build the API path from segments
  // Examples:
  // ['competitions'] -> /competitions
  // ['competitions', '2013', 'teams'] -> /competitions/2013/teams
  const apiPath = pathSegments.join('/');
  
  // Build query string from remaining params
  const qs = new URLSearchParams(params);
  const queryString = qs.toString() ? `?${qs.toString()}` : '';
  
  const url = `https://api.football-data.org/v4/${apiPath}${queryString}`;
  
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