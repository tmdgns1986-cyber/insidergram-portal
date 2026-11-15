// 네이버웍스 로그인 완료 후 돌아오는 곳: state 확인 → 토큰 저장 → 회의AI에이전트로 이동
const { adminClient } = require('../lib/auth');
const { exchangeCode } = require('../lib/naverworks');

const back = (msg) => ({ statusCode: 302, headers: { Location: '/meeting/?nw=' + encodeURIComponent(msg) }, body: '' });

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.error) return back('fail:' + q.error);
  if (!q.code || !q.state) return back('fail:missing');
  const sb = adminClient();
  const { data } = await sb.from('meeting_sync_state').select('value').eq('key', 'oauth_state').maybeSingle();
  const v = data && data.value;
  // 일회성: 확인 즉시 폐기
  await sb.from('meeting_sync_state').delete().eq('key', 'oauth_state');
  if (!v || v.state !== q.state || Date.now() > v.exp) return back('fail:state');
  try {
    await exchangeCode(q.code, v.user_id);
    return back('ok');
  } catch (e) {
    console.error(e);
    return back('fail:token');
  }
};
