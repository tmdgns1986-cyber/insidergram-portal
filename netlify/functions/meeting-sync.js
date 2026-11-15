// 15분마다 자동 실행: 네이버웍스 회의록 → 포털 DB (netlify.toml에 스케줄 설정)
const { runSync } = require('../lib/meetingSync');

exports.handler = async () => {
  try {
    // 15분마다: 짝수 회차는 새 글 동기화, 홀수 회차는 AI 분석 (시간 제한 대응)
    const slot = Math.floor(Date.now() / (15 * 60 * 1000)) % 2;
    const log = await runSync({ deadlineMs: 24000, analyzeOnly: slot === 1 });
    return { statusCode: 200, body: JSON.stringify(log) };
  } catch (e) {
    console.error('meeting-sync 실패', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
