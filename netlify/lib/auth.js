// 공통 인증: 포털에 로그인한 직원만 서버 함수를 쓸 수 있게 막는다.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wykcorpvmnfjqbvqynla.supabase.co';

function adminClient() {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// 성공: { user, role, sb }  /  실패: { response }
async function requireUser(event, { adminOnly = false } = {}) {
  const h = event.headers || {};
  const authHeader = h.authorization || h.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return { response: json(401, { error: '로그인이 필요합니다.' }) };

  const sb = adminClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) {
    return { response: json(401, { error: '로그인 정보가 유효하지 않습니다. 다시 로그인해 주세요.' }) };
  }
  const { data: role } = await sb.from('user_roles')
    .select('user_id, name, role, department').eq('user_id', data.user.id).single();
  if (!role) return { response: json(403, { error: '포털 직원 정보가 없습니다. 관리자에게 문의해 주세요.' }) };
  if (adminOnly && role.role !== 'admin') return { response: json(403, { error: '관리자만 사용할 수 있습니다.' }) };
  return { user: data.user, role, sb };
}

module.exports = { requireUser, adminClient, json };
