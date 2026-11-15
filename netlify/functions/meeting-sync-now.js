// 관리자 수동 동기화 (회의AI에이전트 화면의 "지금 동기화" 버튼)
const { requireUser, json } = require('../lib/auth');
const { runSync } = require('../lib/meetingSync');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireUser(event, { adminOnly: true, meetingBeta: true });
  if (auth.response) return auth.response;
  try {
    const body = JSON.parse(event.body || '{}');
    const log = await runSync({ deadlineMs: 23000, full: !!body.full, analyzeOnly: !!body.analyzeOnly });
    return json(200, { success: true, log });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
