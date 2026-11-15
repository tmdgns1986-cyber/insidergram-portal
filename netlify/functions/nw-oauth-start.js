// 관리자 전용: 네이버웍스 로그인 주소 발급 (위조 방지용 일회성 state 저장)
const crypto = require('crypto');
const { requireUser, json } = require('../lib/auth');
const { authorizeUrl } = require('../lib/naverworks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireUser(event, { adminOnly: true, meetingBeta: true });
  if (auth.response) return auth.response;
  const state = crypto.randomBytes(24).toString('hex');
  await auth.sb.from('meeting_sync_state').upsert({
    key: 'oauth_state', value: { state, user_id: auth.user.id, exp: Date.now() + 10 * 60 * 1000 }, updated_at: new Date().toISOString()
  });
  return json(200, { url: authorizeUrl(state) });
};
