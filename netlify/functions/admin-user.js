const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wykcorpvmnfjqbvqynla.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ── 보안: 로그인한 관리자만 호출 가능 ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const { data: caller, error: callerErr } = await sbAdmin.auth.getUser(token);
  if (callerErr || !caller || !caller.user) {
    return { statusCode: 401, body: JSON.stringify({ error: '로그인 정보가 유효하지 않습니다. 다시 로그인해 주세요.' }) };
  }
  const { data: callerRole } = await sbAdmin.from('user_roles').select('role').eq('user_id', caller.user.id).single();
  if (!callerRole || callerRole.role !== 'admin') {
    return { statusCode: 403, body: JSON.stringify({ error: '관리자만 사용할 수 있는 기능입니다.' }) };
  }

  const ALLOWED_ROLES = ['admin', 'part_leader', 'user'];
  const ALLOWED_DEPTS = ['관리자', '커뮤니케이션팀', '콘텐츠마케팅팀'];
  const normDept = (d) => (d === undefined || d === null || d === '' ? null : d);
  const { action } = body;

  // 사용자 추가
  if (action === 'create_user') {
    const { email, password, name, department, position, role } = body;
    if (!email || !password || !name || !role) {
      return { statusCode: 400, body: JSON.stringify({ error: '필수 항목 누락' }) };
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return { statusCode: 400, body: JSON.stringify({ error: '허용되지 않은 권한 값입니다.' }) };
    }
    if (normDept(department) !== null && !ALLOWED_DEPTS.includes(department)) {
      return { statusCode: 400, body: JSON.stringify({ error: '허용되지 않은 부서입니다.' }) };
    }

    // Supabase Auth에 유저 생성
    const { data: authData, error: authError } = await sbAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true // 이메일 확인 없이 바로 활성화
    });
    if (authError) {
      return { statusCode: 400, body: JSON.stringify({ error: authError.message }) };
    }

    const userId = authData.user.id;
    const canViewPw = role === 'admin';

    // user_roles 테이블에 저장
    const { error: roleError } = await sbAdmin.from('user_roles').insert({
      user_id: userId,
      email,
      name,
      department: normDept(department),
      position: position || null,
      role,
      can_view_password: canViewPw,
      must_change_password: true
    });

    if (roleError) {
      // user_roles 저장 실패 시 Auth 유저도 삭제
      await sbAdmin.auth.admin.deleteUser(userId);
      return { statusCode: 400, body: JSON.stringify({ error: roleError.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, userId }) };
  }

  // 권한 변경
  if (action === 'update_role') {
    const { id, role } = body;
    if (!id || !role) {
      return { statusCode: 400, body: JSON.stringify({ error: '필수 항목 누락' }) };
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return { statusCode: 400, body: JSON.stringify({ error: '허용되지 않은 권한 값입니다.' }) };
    }

    // 안전장치: 마지막 관리자의 관리자 권한은 해제 불가
    if (role !== 'admin') {
      const { data: target } = await sbAdmin.from('user_roles').select('role').eq('id', id).single();
      if (target && target.role === 'admin') {
        const { count } = await sbAdmin.from('user_roles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count || 0) <= 1) {
          return { statusCode: 400, body: JSON.stringify({ error: '마지막 남은 관리자의 권한은 해제할 수 없습니다. 다른 관리자를 먼저 지정해 주세요.' }) };
        }
      }
    }

    const canViewPw = role === 'admin';
    const { error } = await sbAdmin.from('user_roles').update({ role, can_view_password: canViewPw }).eq('id', id);
    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // 사용자 정보 수정 (부서·직책·권한)
  if (action === 'update_user') {
    const { id, department, position, role } = body;
    if (!id || !role) {
      return { statusCode: 400, body: JSON.stringify({ error: '필수 항목 누락' }) };
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return { statusCode: 400, body: JSON.stringify({ error: '허용되지 않은 권한 값입니다.' }) };
    }
    if (normDept(department) !== null && !ALLOWED_DEPTS.includes(department)) {
      return { statusCode: 400, body: JSON.stringify({ error: '허용되지 않은 부서입니다.' }) };
    }
    if (role !== 'admin') {
      const { data: target } = await sbAdmin.from('user_roles').select('role').eq('id', id).single();
      if (target && target.role === 'admin') {
        const { count } = await sbAdmin.from('user_roles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count || 0) <= 1) {
          return { statusCode: 400, body: JSON.stringify({ error: '마지막 남은 관리자의 권한은 해제할 수 없습니다. 다른 관리자를 먼저 지정해 주세요.' }) };
        }
      }
    }
    const { error } = await sbAdmin.from('user_roles').update({
      department: normDept(department),
      position: (position || '').trim() || null,
      role,
      can_view_password: role === 'admin'
    }).eq('id', id);
    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: '알 수 없는 action' }) };
};
