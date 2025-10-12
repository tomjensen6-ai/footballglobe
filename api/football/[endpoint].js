// api/football/[endpoint].js
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint, ...params } = req.query;
  
  // Read API key from environment
  const apiKey = process.env.API_SPORTS_KEY;
  
  // Debug log (you can remove this later)
  console.log('API_SPORTS_KEY exists?', !!apiKey);
  
  if (!apiKey) {
    console.error('❌ API_SPORTS_KEY not found in environment variables');
    return res.status(500).json({ 
      error: 'Missing API_SPORTS_KEY environment variable',
      debug: 'Check Vercel project settings'
    });
  }

  const allowed = new Set(['countries', 'leagues', 'venues', 'teams', 'standings']);
  if (!allowed.has(endpoint)) {
    return res.status(400).json({ error: `Unsupported endpoint: ${endpoint}` });
  }

  const qs = new URLSearchParams(params);
  const url = `https://v3.football.api-sports.io/${endpoint}?${qs.toString()}`;

  console.log(`🌐 Proxying request to: ${url}`);

  try {
    const upstream = await fetch(url, {
      headers: { 
        'x-apisports-key': apiKey  // Make sure this header name is correct
      }
    });
    
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('❌ Proxy error:', e);
    return res.status(502).json({ 
      error: 'Proxy error', 
      detail: String(e) 
    });
  }
}
