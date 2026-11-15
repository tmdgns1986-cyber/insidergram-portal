// 회의AI에이전트: 브리핑 / 질문 답변
// 보안: 요청자 권한으로 볼 수 있는 게시판의 회의록만 AI에 전달 (다른 게시판 내용은 서버에서 아예 제외)
const { requireUser, json } = require('../lib/auth');

const MODEL = 'claude-haiku-4-5';

function canView(role, board) {
  if (board === 'all') return true;
  if (board === 'comm') return role.role === 'admin' || role.department === '관리자' || role.department === '커뮤니케이션팀';
  return false;
}

async function claude(prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('AI 오류: ' + JSON.stringify(data.error || data).slice(0, 200));
  const text = (data.content || []).map(c => c.text || '').join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  return JSON.parse(text.slice(s, e + 1));
}

function compact(p, withBody) {
  const a = p.analysis || {};
  return {
    ref: p.id, title: p.title, date: a.meeting_date || (p.created_time || '').slice(0, 10), author: p.author,
    summary: a.summary, decisions: a.decisions, open_issues: a.open_issues, action_items: a.action_items,
    ...(withBody ? { body: (p.body || '').slice(0, 6000) } : {})
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireUser(event);
  if (auth.response) return auth.response;
  const { role, sb } = auth;

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const board = req.board;
  if (!canView(role, board)) return json(403, { error: '이 회의록 게시판을 볼 권한이 없습니다.' });

  // 선택한 게시판 + 프로젝트의 회의록만 조회
  let q = sb.from('meeting_posts')
    .select('id, title, author, created_time, url, project, analysis, body')
    .eq('board_key', board).order('created_time', { ascending: false }).limit(40);
  if (req.project) q = q.eq('project', req.project);
  const { data: posts, error } = await q;
  if (error) return json(500, { error: error.message });
  if (!posts || !posts.length) return json(200, { empty: true });

  const recent = posts.slice(0, 3).map(p => compact(p, true));
  const older = posts.slice(3).map(p => compact(p, false));
  const ctx = JSON.stringify({ recent_meetings_full: recent, older_meetings_summary: older });
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    if (req.action === 'brief') {
      const out = await claude(`너는 회의 진행을 돕는 비서다. 아래는 "${req.project || '전체'}" 관련 지난 회의록이다(최신순). 오늘은 ${today}.
이 자료만 근거로 판단하고, 없는 내용은 만들지 마라. JSON만 출력:
{"flow":[{"date":"YYYY-MM-DD","title":"회의명","point":"핵심 한 줄","ref":"근거 ref"}],
 "decisions":[{"text":"결정사항","ref":"ref"}],
 "open_issues":[{"text":"미결/보류 사항","ref":"ref"}],
 "action_items":[{"owner":"담당자","task":"할 일","due":"기한|null","status":"완료|진행중|기한지남|확인필요","ref":"ref"}],
 "agenda":["오늘 회의 안건 제안 (미결·기한 임박 기준) 3~5개"]}
flow는 오래된→최신 순서로 최대 8개.
자료: ${ctx}`, 3000);
      return json(200, { brief: out, refs: posts.map(p => ({ id: p.id, title: p.title, date: (p.created_time || '').slice(0, 10), url: p.url })) });
    }
    if (req.action === 'ask') {
      const question = String(req.question || '').slice(0, 1000);
      if (!question) return json(400, { error: '질문을 입력해 주세요.' });
      const out = await claude(`너는 회의 중 질문에 답하는 비서다. 아래 회의록 자료만 근거로 답하라. 자료에 없으면 "회의록에서 찾지 못했습니다"라고 답하라.
다른 게시판이나 자료 밖의 내용은 추측하지 마라. JSON만 출력: {"answer":"답변(2~5문장, 존댓말)","refs":["근거 ref"]}
질문: ${question}
자료: ${ctx}`, 1200);
      return json(200, { answer: out.answer, refs: (out.refs || []).map(r => posts.find(p => p.id === r)).filter(Boolean).map(p => ({ id: p.id, title: p.title, date: (p.created_time || '').slice(0, 10), url: p.url })) });
    }
    return json(400, { error: '알 수 없는 요청' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
