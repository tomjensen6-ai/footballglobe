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
  
  // 🔥 ENHANCED DEBUGGING
  console.log('🔍 RAW REQUEST:', {
    url: req.url,
    query: req.query,
    path: req.query.path,
    method: req.method
  });
  
  if (!apiToken) {
    console.log('❌ Missing API token');
    return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_TOKEN' });
  }

  // 🔥 FIX: Extract path from query with better handling
  let pathSegments = req.query.path;
  
  // 🔥 CRITICAL: Check if path exists
  if (!pathSegments || (Array.isArray(pathSegments) && pathSegments.length === 0)) {
    console.log('❌ No path segments found. Query:', req.query);
    console.log('💡 Expected format: /api/football/competitions (not /api/football?path=competitions)');
    return res.status(400).json({ 
      error: 'No path provided',
      received: req.query,
      hint: 'URL should be /api/football/competitions not /api/football?endpoint=competitions'
    });
  }
  
  // Ensure it's an array
  if (!Array.isArray(pathSegments)) {
    pathSegments = [pathSegments];
  }
  
  console.log('✅ Path segments:', pathSegments);
  
  // Build the API path from segments
  const apiPath = pathSegments.join('/');
  
  // Remove 'path' from params and build query string from remaining params
  const { path, ...otherParams } = req.query;
  const qs = new URLSearchParams(otherParams);
  const queryString = qs.toString() ? `?${qs.toString()}` : '';
  
  const url = `https://api.football-data.org/v4/${apiPath}${queryString}`;
  
  console.log('🌐 Proxying to:', url);

  try {
    const upstream = await fetch(url, {
      headers: {
        'X-Auth-Token': apiToken
      }
    });
    
    const data = await upstream.json();
    console.log('✅ Response status:', upstream.status);
    
    // 🔥 ADD: Log first item for debugging
    if (data.competitions) {
      console.log('📊 Competitions count:', data.competitions.length);
    }
    
    return res.status(upstream.status).json(data);
    
  } catch (e) {
    console.error('❌ Proxy error:', e);
    return res.status(502).json({ error: 'Proxy error', detail: String(e) });
  }
}