// 네이버웍스 API (관리자 1회 로그인 → 자동 갱신, 게시판 읽기 전용 board.read)

// 공개돼도 되는 식별값 (비밀 아님)
const CLIENT_ID = process.env.NW_CLIENT_ID || '5nwQaAE6kJlBqh5mSaYh';
const API = 'https://www.worksapis.com/v1.0';

let cached = null;
const REDIRECT_URI = 'https://insidergram.it.kr/.netlify/functions/nw-oauth-callback';
const TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';

function sbAdmin() { return require('./auth').adminClient(); }

async function tokenRequest(params) {
  if (!process.env.NW_CLIENT_SECRET) throw new Error('네이버웍스 Client Secret(NW_CLIENT_SECRET)이 Netlify에 설정되지 않았습니다.');
  const form = new URLSearchParams({ client_id: CLIENT_ID, client_secret: process.env.NW_CLIENT_SECRET, ...params });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('네이버웍스 토큰 발급 실패: ' + (data.error_description || data.error || res.status));
  return data;
}

async function saveTokens(data, extra = {}) {
  const row = { id: 1, access_token: data.access_token, expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString(), ...extra };
  if (data.refresh_token) row.refresh_token = data.refresh_token;
  await sbAdmin().from('nw_tokens').upsert(row);
}

// 관리자가 한 번 로그인해서 받은 코드를 토큰으로 교환 (게시판 읽기 전용)
async function exchangeCode(code, connectedBy) {
  const data = await tokenRequest({ grant_type: 'authorization_code', code });
  await saveTokens(data, { connected_by: connectedBy || null });
  cached = null;
}

function authorizeUrl(state) {
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'board.read', response_type: 'code', state });
  return 'https://auth.worksmobile.com/oauth2/v2.0/authorize?' + q.toString();
}

async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const { data: t } = await sbAdmin().from('nw_tokens').select('*').eq('id', 1).maybeSingle();
  if (!t || !t.refresh_token) throw new Error('네이버웍스 연결이 필요합니다. 회의AI에이전트 화면에서 관리자가 "네이버웍스 연결"을 한 번 눌러 주세요.');
  if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() > Date.now() + 120000) {
    cached = { token: t.access_token, exp: new Date(t.expires_at).getTime() };
    return t.access_token;
  }
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  await saveTokens(data);
  cached = { token: data.access_token, exp: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function get(path) {
  const token = await accessToken();
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
  // 게시판·게시글 ID가 19자리라 숫자로 읽으면 반올림됨 → 큰 숫자는 문자열로 보존
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw.replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')); } catch { data = {}; }
  if (!res.ok) throw new Error(`네이버웍스 API 오류 ${res.status} ${path}: ${data.description || data.code || ''}`);
  return data;
}

async function listBoards() {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const d = await get('/boards?count=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(d.boards || []));
    cursor = d.responseMetaData && d.responseMetaData.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function listPosts(boardId, cursor) {
  return get(`/boards/${encodeURIComponent(boardId)}/posts?count=40` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
}

async function getPost(boardId, postId) {
  return get(`/boards/${encodeURIComponent(boardId)}/posts/${encodeURIComponent(postId)}`);
}

module.exports = { listBoards, listPosts, getPost, accessToken, exchangeCode, authorizeUrl };
