export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    
    if (!target || !target.startsWith('https://api.sam.gov/')) {
      return new Response('Invalid target', { status: 400 });
    }

    const samUrl = decodeURIComponent(target);
    
    try {
      const response = await fetch(samUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Ironstone-OpenClaw/1.0'
        }
      });
      
      const data = await response.text();
      
      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
