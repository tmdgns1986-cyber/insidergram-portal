// 15분마다 자동 실행: 네이버웍스 회의록 → 포털 DB (netlify.toml에 스케줄 설정)
const { runSync } = require('../lib/meetingSync');

exports.handler = async () => {
  try {
    const log = await runSync({ deadlineMs: 24000 });
    return { statusCode: 200, body: JSON.stringify(log) };
  } catch (e) {
    console.error('meeting-sync 실패', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
