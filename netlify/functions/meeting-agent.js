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
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }],
      tools: [{ name: 'output', description: '결과를 JSON으로 제출', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'output' } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('AI 오류: ' + JSON.stringify(data.error || data).slice(0, 200));
  const tool = (data.content || []).find(c => c.type === 'tool_use');
  if (tool && tool.input) return tool.input;
  const text = (data.content || []).map(c => c.text || '').join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  return JSON.parse(text.slice(s, e + 1));
}

function compact(p, withBody) {
  const a = p.analysis || {};
  return {
    ref: p.id, title: p.title, date: a.meeting_date || (p.created_time || '').slice(0, 10), author: p.author,
    summary: a.summary, decisions: a.decisions, open_issues: a.open_issues, action_items: a.action_items,
    ...(withBody ? { body: (p.body || '').slice(0, 4000) } : {})
  };
}

// 질문과 관련 있는 회의록 점수 (제목 > 요약 > 본문)
function keywords(q) {
  const words = String(q).toLowerCase().split(/[^0-9a-z가-힣]+/).filter(w => w.length >= 2);
  const out = new Set();
  for (const w of words) { out.add(w); if (w.length >= 3) out.add(w.slice(0, -1)); }  // 조사 대비
  return [...out];
}
function score(p, keys) {
  const a = p.analysis || {};
  const title = (p.title || '').toLowerCase();
  const summ = JSON.stringify([a.summary, a.decisions, a.open_issues, a.action_items]).toLowerCase();
  const body = (p.body || '').toLowerCase();
  let s = 0;
  for (const k of keys) {
    if (title.includes(k)) s += 5;
    if (summ.includes(k)) s += 3;
    s += Math.min(body.split(k).length - 1, 5);
  }
  return s;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await requireUser(event, { meetingBeta: true });
  if (auth.response) return auth.response;
  const { role, sb } = auth;

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const board = req.board;
  if (!canView(role, board)) return json(403, { error: '이 회의록 게시판을 볼 권한이 없습니다.' });

  // 선택한 게시판의 회의록 전체 (다른 게시판은 조회 자체를 하지 않음)
  const { data: posts, error } = await sb.from('meeting_posts')
    .select('id, title, author, created_time, url, analysis, body')
    .eq('board_key', board).order('created_time', { ascending: false }).limit(500);
  if (error) return json(500, { error: error.message });
  if (!posts || !posts.length) return json(200, { empty: true });

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const refOut = list => list.map(p => ({ id: p.id, title: p.title, date: (p.created_time || '').slice(0, 10), url: p.url }));

  try {
    if (req.action === 'brief') {
      const recent = posts.slice(0, 10);
      const ctx = JSON.stringify({ recent_meetings_full: recent.slice(0, 3).map(p => compact(p, true)), older_meetings_summary: recent.slice(3).map(p => compact(p, false)) });
      const out = await claude(`너는 회의 진행을 돕는 비서다. 아래는 최근 회의록이다(최신순, 여러 프로젝트가 섞여 있음). 오늘은 ${today}.
이 자료만 근거로 판단하고, 없는 내용은 만들지 마라. 각 항목 앞에 어느 프로젝트/건인지 짧게 붙여라(예: "[샤브20] ...").
output 도구로 제출(형식):
{"flow":[{"date":"YYYY-MM-DD","title":"회의명","point":"핵심 한 줄","ref":"근거 ref"}],
 "open_issues":[{"text":"미결/보류 사항","ref":"ref"}],
 "action_items":[{"owner":"담당자","task":"할 일","due":"기한|null","status":"완료|진행중|기한지남|확인필요","ref":"ref"}],
 "agenda":["오늘 회의 안건 제안 (미결·기한 임박 기준) 3~5개"]}
flow는 최신→오래된 순서로 최대 10개.
자료: ${ctx}`, 3000);
      return json(200, { brief: out, refs: refOut(recent) });
    }
    if (req.action === 'ask') {
      const question = String(req.question || '').slice(0, 1000);
      if (!question) return json(400, { error: '질문을 입력해 주세요.' });
      const keys = keywords(question);
      const ranked = posts.map((p, i) => ({ p, s: score(p, keys), i }))
        .sort((a, b) => b.s - a.s || a.i - b.i);
      const top = ranked.filter(x => x.s > 0).slice(0, 4).map(x => x.p);
      const full = top.length ? top : posts.slice(0, 3);
      const fullIds = new Set(full.map(p => p.id));
      const rest = ranked.map(x => x.p).filter(p => !fullIds.has(p.id)).slice(0, 40);
      const ctx = JSON.stringify({ most_relevant_full: full.map(p => compact(p, true)), other_meetings_summary: rest.map(p => compact(p, false)) });
      const out = await claude(`너는 회의 중 질문에 답하는 비서다. 오늘은 ${today}. 아래는 한 게시판의 회의록 전체에서 뽑은 자료다(여러 프로젝트가 섞여 있음).
이 자료만 근거로 답하라. 자료에 없으면 "회의록에서 찾지 못했습니다"라고 답하라. 자료 밖의 내용은 추측하지 마라.
여러 회의에 걸친 내용이면 날짜순으로 정리하고, 가장 최근 결정을 기준으로 답하라.
output 도구로 제출(형식): {"answer":"답변(2~6문장, 존댓말)","refs":["근거 ref"]}
질문: ${question}
자료: ${ctx}`, 1500);
      return json(200, { answer: out.answer, refs: refOut((out.refs || []).map(r => posts.find(p => p.id === r)).filter(Boolean)) });
    }
    return json(400, { error: '알 수 없는 요청' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
