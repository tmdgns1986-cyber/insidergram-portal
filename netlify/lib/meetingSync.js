// 네이버웍스 회의록 → Supabase 동기화 + AI 분석
const nw = require('./naverworks');
const { adminClient } = require('./auth');

const ANALYZE_MODEL = 'claude-haiku-4-5';

function boardKeyOf(name) {
  const n = (name || '').replace(/\s+/g, '');
  if (n.includes('커뮤니케이션') && n.includes('회의록')) return 'comm';
  if (n.includes('전체회의록') || n.includes('미팅록')) return 'all';
  return null;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function setState(sb, key, value) {
  await sb.from('meeting_sync_state').upsert({ key, value, updated_at: new Date().toISOString() });
}

async function findBoards() {
  const boards = await nw.listBoards();
  const map = {};
  if (process.env.NW_BOARD_ALL_ID) map.all = { boardId: process.env.NW_BOARD_ALL_ID, boardName: '전체회의록&미팅록' };
  if (process.env.NW_BOARD_COMM_ID) map.comm = { boardId: process.env.NW_BOARD_COMM_ID, boardName: '커뮤니케이션팀 회의록' };
  for (const b of boards) {
    const k = boardKeyOf(b.boardName);
    if (k && !map[k]) map[k] = { boardId: String(b.boardId), boardName: b.boardName };
  }
  return { map, names: boards.map(b => `${b.boardName}(${b.boardId})`) };
}

async function claudeJSON(prompt, maxTokens = 2000, timeoutMs = 18000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANALYZE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }],
      tools: [{ name: 'output', description: '결과를 JSON으로 제출', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'output' } })
  });
  clearTimeout(timer);
  const data = await res.json();
  if (!res.ok) throw new Error('AI 분석 실패: ' + JSON.stringify(data.error || data).slice(0, 200));
  const tool = (data.content || []).find(c => c.type === 'tool_use');
  if (tool && tool.input) return tool.input;
  const text = (data.content || []).map(c => c.text || '').join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  return JSON.parse(text.slice(s, e + 1));
}

async function analyzePost(sb, post) {
  const { data: projRows } = await sb.from('meeting_posts').select('project').eq('board_key', post.board_key).not('project', 'is', null);
  const known = [...new Set((projRows || []).map(r => r.project))].slice(0, 80);
  const prompt = `다음은 광고·마케팅 대행사 회의록 게시글이다. 분석해서 output 도구로 제출해라.
기존 프로젝트명 목록(같은 프로젝트면 반드시 이 이름을 그대로 재사용): ${JSON.stringify(known)}
출력 형식:
{"project":"프로젝트명(클라이언트/캠페인 단위, 짧게. 여러 프로젝트 공통 회의면 '공통/전사')",
 "meeting_date":"YYYY-MM-DD 또는 null","attendees":["이름"],
 "summary":"3~5문장 요약",
 "decisions":["결정된 사항"],"open_issues":["보류·미결 사항"],
 "action_items":[{"owner":"담당자","task":"할 일","due":"기한 또는 null"}]}

제목: ${post.title}
작성자: ${post.author || ''}
작성일: ${post.created_time || ''}
본문:
${(post.body || '').slice(0, 8000)}`;
  const a = await claudeJSON(prompt);
  await sb.from('meeting_posts').update({
    project: (a.project || '미분류').slice(0, 60),
    analysis: a,
    analyzed_at: new Date().toISOString(),
    analyzed_modified: post.modified_time
  }).eq('id', post.id);
}

// deadlineMs 안에서 가능한 만큼 진행 (함수 시간 제한 대응, 다음 실행 때 이어서)
async function runSync({ deadlineMs = 22000, full = false, analyzeOnly = false } = {}) {
  const started = Date.now();
  const left = () => deadlineMs - (Date.now() - started);
  const sb = adminClient();
  const log = { boards: {}, listed: 0, bodies: 0, analyzed: 0, errors: [] };

  if (analyzeOnly) {
    // 분석만: 게시판 조회 생략하고 바로 AI 분석
    const { data: needAI } = await sb.from('meeting_posts')
      .select('id, board_key, title, author, created_time, modified_time, body, analyzed_modified')
      .not('body', 'is', null).is('analyzed_at', null)
      .order('created_time', { ascending: false }).limit(1);
    for (const p of needAI || []) {
      try { await analyzePost(sb, p); log.analyzed++; } catch (e) { log.errors.push(e.message); }
    }
    const { count } = await sb.from('meeting_posts').select('id', { count: 'exact', head: true }).is('analyzed_at', null);
    log.pendingAnalysis = count || 0;
    return log;
  }

  const { map, names } = await findBoards();
  log.allBoardNames = names;
  if (!map.all && !map.comm) {
    log.errors.push('회의록 게시판을 찾지 못했습니다. (서비스 계정이 볼 수 있는 게시판: ' + names.join(', ') + ')');
    await setState(sb, 'last_run', { at: new Date().toISOString(), ...log });
    return log;
  }

  // 가져오는 범위: 오늘 기준 최근 3개월
  const cutoff = new Date(Date.now() - 92 * 24 * 3600 * 1000);
  await sb.from('meeting_posts').delete().lt('created_time', cutoff.toISOString());

  // 1) 목록 동기화 (새 글·수정된 글)
  for (const key of (analyzeOnly ? [] : ['all', 'comm'])) {
    const b = map[key];
    if (!b) continue;
    log.boards[key] = b.boardName;
    let cursor = '';
    for (let page = 0; page < 30 && left() > 8000; page++) {
      let d;
      try { d = await nw.listPosts(b.boardId, cursor); }
      catch (e) { log.errors.push(`[${b.boardName} ${b.boardId}] ${e.message}`); break; }
      const all = d.posts || [];
      if (!all.length) break;
      const posts = all.filter(p => p.createdTime && new Date(p.createdTime) >= cutoff);
      const reachedOld = posts.length < all.length;
      const rows = posts.map(p => ({
        board_key: key, board_id: String(b.boardId), post_id: String(p.postId),
        title: p.title, author: p.userName || null,
        created_time: p.createdTime || null, modified_time: p.modifiedTime || p.createdTime || null,
        url: `https://board.worksmobile.com/main/board/${b.boardId}/post/${p.postId}`,
        synced_at: new Date().toISOString()
      }));
      if (rows.length) {
        const { error } = await sb.from('meeting_posts').upsert(rows, { onConflict: 'board_id,post_id' });
        if (error) log.errors.push(error.message);
      }
      log.listed += rows.length;
      cursor = d.responseMetaData && d.responseMetaData.nextCursor;
      if (!cursor || reachedOld) break;
    }
  }

  // 2) 본문 가져오기 (없거나 수정된 글)
  const { data: needBody } = await sb.from('meeting_posts')
    .select('id, board_id, post_id, modified_time, body_fetched_at')
    .or('body_fetched_at.is.null')
    .order('created_time', { ascending: false }).limit(40);
  for (const p of needBody || []) {
    if (left() < 7000) break;
    try {
      const d = await nw.getPost(p.board_id, p.post_id);
      await sb.from('meeting_posts').update({ body: htmlToText(d.body || d.content || ''), body_fetched_at: new Date().toISOString() }).eq('id', p.id);
      log.bodies++;
    } catch (e) { log.errors.push(e.message); }
  }

  // 3) AI 분석 (본문 있고 아직 분석 안 됐거나 수정된 글)
  const { data: needAI } = await sb.from('meeting_posts')
    .select('id, board_key, title, author, created_time, modified_time, body, analyzed_modified')
    .not('body', 'is', null).is('analyzed_at', null)
    .order('created_time', { ascending: false }).limit(12);
  for (const p of needAI || []) {
    if (left() < 17000) break;
    try { await analyzePost(sb, p); log.analyzed++; } catch (e) { log.errors.push(e.message); }
  }

  const { count: pending } = await sb.from('meeting_posts').select('id', { count: 'exact', head: true }).is('analyzed_at', null);
  log.pendingAnalysis = pending || 0;
  await setState(sb, 'last_run', { at: new Date().toISOString(), ms: Date.now() - started, ...log });
  return log;
}

module.exports = { runSync, boardKeyOf, htmlToText };
