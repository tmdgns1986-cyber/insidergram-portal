exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키 없음' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    // max_tokens 충분히 늘림 (JSON이 잘리지 않도록)
    body.max_tokens = 6000;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: JSON.stringify(data.error || data) })
      };
    }

    const rawText = (data.content || []).map(c => c.text || '').join('');

    const s = rawText.indexOf('{');
    const e = rawText.lastIndexOf('}');

    if (s === -1 || e === -1) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'JSON 없음 (응답이 잘렸을 수 있음): ' + rawText.slice(0, 200) })
      };
    }

    const jsonStr = rawText.slice(s, e + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch(pe) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '파싱실패: ' + pe.message })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: parsed })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '서버 오류: ' + err.message })
    };
  }
};
