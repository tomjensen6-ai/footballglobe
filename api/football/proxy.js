export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.FOOTBALL_DATA_API_TOKEN;
  const { path, ...params } = req.query;
  
  if (!token) {
    return res.status(500).json({ error: 'Missing token' });
  }
  
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Build query string from remaining params
  const qs = new URLSearchParams(params).toString();
  const queryString = qs ? `?${qs}` : '';
  
  // Construct full URL
  const url = `https://api.football-data.org/v4/${path}${queryString}`;
  
  console.log('🌐 Proxy:', url);

  try {
    const upstream = await fetch(url, {
      headers: { 'X-Auth-Token': token }
    });
    
    const data = await upstream.json();
    console.log('✅ Status:', upstream.status);
    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('❌ Error:', e);
    return res.status(502).json({ error: String(e) });
  }
}