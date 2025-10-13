// api/football/[...path].js
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiToken = process.env.FOOTBALL_DATA_API_TOKEN;
  
  console.log('🔑 FOOTBALL_DATA_API_TOKEN exists?', !!apiToken);
  console.log('📍 Full query:', req.query);
  
  if (!apiToken) {
    return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_TOKEN' });
  }

  // Extract path from query - Vercel puts it in req.query.path as an array
  let pathSegments = req.query.path;
  
  // Ensure it's an array
  if (!pathSegments) {
    console.log('❌ No path segments found');
    return res.status(400).json({ error: 'No path provided' });
  }
  
  if (!Array.isArray(pathSegments)) {
    pathSegments = [pathSegments];
  }
  
  console.log('📍 Path segments:', pathSegments);
  
  // Build the API path from segments
  const apiPath = pathSegments.join('/');
  
  // Remove 'path' from params and build query string from remaining params
  const { path, ...otherParams } = req.query;
  const qs = new URLSearchParams(otherParams);
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
    console.log('✅ Proxy response status:', upstream.status);
    return res.status(upstream.status).json(data);
    
  } catch (e) {
    console.error('❌ Proxy error:', e);
    return res.status(502).json({ error: 'Proxy error', detail: String(e) });
  }
}