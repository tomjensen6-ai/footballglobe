export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.FOOTBALL_DATA_API_TOKEN;
  
  if (!token) {
    return res.status(500).json({ error: 'Missing token' });
  }

  try {
    const upstream = await fetch('https://api.football-data.org/v4/competitions', {
      headers: { 'X-Auth-Token': token }
    });
    
    const data = await upstream.json();
    console.log('✅ Success:', data.competitions?.length, 'competitions');
    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('❌ Error:', e);
    return res.status(502).json({ error: String(e) });
  }
}