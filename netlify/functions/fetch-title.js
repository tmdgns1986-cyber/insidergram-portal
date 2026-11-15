const { requireUser } = require('../lib/auth');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 보안: 포털 직원만 사용 + 공개 웹 주소(http/https)만 허용
  const auth = await requireUser(event);
  if (auth.response) return auth.response;

  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'URL이 없습니다.' })
      };
    }

    let target;
    try { target = new URL(url); } catch { target = null; }
    const host = target ? target.hostname.toLowerCase() : '';
    const privateHost = !target || !['http:', 'https:'].includes(target.protocol)
      || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
      || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.includes(':') || host === '';
    if (privateHost) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '공개 웹 주소(http/https)만 확인할 수 있습니다.' }) };
    }

    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InsidergramBot/1.0)' }
    });

    if (!res.ok) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `페이지를 불러오지 못했습니다 (HTTP ${res.status})` })
      };
    }

    const html = await res.text();

    // og:title 우선, 없으면 <title> 태그
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

    let title = (ogMatch && ogMatch[1]) || (titleMatch && titleMatch[1]) || '';
    title = title
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .trim();

    if (!title) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '제목을 찾지 못했습니다.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '가져오기 실패: ' + err.message })
    };
  }
};
