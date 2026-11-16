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
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], temperature: 0,
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
  const auth = await requireUser(event);
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
      // AI에는 짧은 번호(M1, M2…)로 근거를 표시하게 하고, 서버에서 실제 회의록과 대조한다
      const ctxPosts = [...full, ...rest];
      const refOf = {}; ctxPosts.forEach((p, i) => { refOf['M' + (i + 1)] = p; });
      const tag = (p) => 'M' + (ctxPosts.indexOf(p) + 1);
      const ctx = JSON.stringify({
        most_relevant_full: full.map(p => ({ ...compact(p, true), ref: tag(p) })),
        other_meetings_summary: rest.map(p => ({ ...compact(p, false), ref: tag(p) }))
      });
      const out = await claude(`너는 회의 중 질문에 답하는 비서다. 오늘은 ${today}. 아래는 한 게시판의 회의록에서 뽑은 자료다(여러 프로젝트가 섞여 있음). 각 회의록에는 ref(M1, M2…)가 붙어 있다.

[사실 기반 원칙 — 반드시 지켜라]
1. 자료에 적힌 내용만 쓴다. 추측·일반론·상식으로 빈칸을 채우지 마라.
2. 숫자·금액·날짜·이름은 자료에 적힌 그대로 쓴다. 계산하거나 반올림해서 새 숫자를 만들지 마라.
3. 질문한 사람·회의·내용이 자료에 없으면 mode를 "not_found"로 하고 "회의록에서 찾지 못했습니다"라고 분명히 말한다. 비슷한 다른 내용을 그 답인 것처럼 말하지 마라.
4. 질문의 전제가 자료와 다르면(예: 그런 회의·발언이 없음) 그 사실을 그대로 말한다.
5. 모든 항목에는 근거 ref를 붙인다. ref를 붙일 수 없는 내용은 쓰지 마라.
6. 담당자·기한이 자료에 없으면 owner는 "담당 미정", due는 null. 지어내지 마라.
7. 할 일 status: 이후 회의록에 완료 기록이 있으면 "완료", 기한이 오늘보다 지났는데 완료 기록이 없으면 "기한지남", 진행 중이라고 적혀 있으면 "진행중", 그 외는 "확인필요".
8. 여러 회의에 걸친 내용이면 가장 최근 회의 기준으로 답하고, 바뀐 이력은 날짜와 함께 적는다.
9. 의견·평가·감정 표현을 넣지 말고 객관적으로 쓴다. 존댓말.

[답변 형태(mode) 고르기]
- "short": 특정 사실 하나를 묻는 짧은 질문(금액, 날짜, 누가, 몇 개 등). lead에 답 한두 문장, context에 필요한 배경 0~2줄만.
- "summary": 회의 내용 정리·요약·흐름·리마인드를 요청한 경우. 아래 칸을 자료에 있는 만큼만 채운다(없으면 빈 배열).
- "not_found": 자료에서 답을 찾지 못한 경우. lead에 찾지 못했다는 사실, related에 자료에 실제로 있는 가장 가까운 정보(없으면 null).

today_points(오늘 회의에서 논의할 것)는 summary일 때만, 자료의 미결 사항·기한 지난/임박한 할 일·담당자 없는 할 일에 근거해서 2~3개. why에는 근거가 된 사실만, ask에는 회의에서 바로 던질 질문 한 문장.
follow_ups: 이어서 물어볼 만한 짧은 질문 2~3개(자료로 답할 수 있는 것만).

output 도구로 제출(형식):
{"mode":"short|summary|not_found",
 "lead":"핵심 답 1~2문장",
 "context":[{"text":"배경 한 줄","date":"MM.DD","ref":"M1"}],
 "flow":[{"date":"YYYY-MM-DD","point":"그 회의의 핵심 한 줄","ref":"M1"}],
 "decisions":[{"text":"결정된 것","date":"MM.DD","ref":"M1"}],
 "action_items":[{"owner":"담당자|담당 미정","task":"할 일","due":"기한|null","status":"완료|진행중|기한지남|확인필요","ref":"M1"}],
 "open_issues":[{"text":"아직 안 정해진 것","ref":"M1"}],
 "today_points":[{"title":"논의 주제","why":"근거 사실","ask":"회의에서 던질 질문","ref":"M1"}],
 "related":"not_found일 때 가장 가까운 실제 정보 또는 null",
 "refs":["답에 쓴 ref 전부"],
 "follow_ups":["이어서 물어볼 질문"]}
flow는 오래된→최신 순서.
질문: ${question}
자료: ${ctx}`, 2500);

      // ── 서버 검증: 자료에 없는 ref가 붙은 항목은 버린다 ──
      const ok = (x) => x && typeof x === 'object' && refOf[x.ref];
      const arr = (a) => Array.isArray(a) ? a.filter(ok) : [];
      const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
      const ans = {
        mode: ['short', 'summary', 'not_found'].includes(out.mode) ? out.mode : 'short',
        lead: str(out.lead, 600),
        context: arr(out.context).slice(0, 3),
        flow: arr(out.flow).slice(0, 10),
        decisions: arr(out.decisions).slice(0, 10),
        action_items: arr(out.action_items).slice(0, 12),
        open_issues: arr(out.open_issues).slice(0, 8),
        today_points: arr(out.today_points).slice(0, 3),
        related: str(out.related, 400) || null,
        follow_ups: (Array.isArray(out.follow_ups) ? out.follow_ups : []).filter(q => typeof q === 'string').slice(0, 3).map(q => q.slice(0, 60))
      };
      const used = new Set([...(Array.isArray(out.refs) ? out.refs : []), ...['context', 'flow', 'decisions', 'action_items', 'open_issues', 'today_points'].flatMap(k => ans[k].map(x => x.ref))].filter(r => refOf[r]));
      // 근거가 하나도 없는데 답을 했다면 사실로 볼 수 없으므로 '찾지 못함'으로 바꾼다
      if (ans.mode !== 'not_found' && !used.size) {
        ans.mode = 'not_found';
        ans.lead = '회의록에서 근거를 찾지 못했습니다.';
        ans.related = null;
        ['context', 'flow', 'decisions', 'action_items', 'open_issues', 'today_points'].forEach(k => { ans[k] = []; });
      }
      if (ans.mode !== 'summary') ans.today_points = [];
      if (!ans.lead) ans.lead = ans.mode === 'not_found' ? '회의록에서 찾지 못했습니다.' : '';
      const refMap = {};
      for (const r of used) {
        const p = refOf[r];
        refMap[r] = { title: p.title, date: (p.analysis && p.analysis.meeting_date) || (p.created_time || '').slice(0, 10), url: p.url };
      }
      return json(200, { answer: ans, refs: refMap });
    }
    return json(400, { error: '알 수 없는 요청' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
