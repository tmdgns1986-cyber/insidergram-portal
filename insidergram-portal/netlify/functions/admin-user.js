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

  const { action } = body;

  // 사용자 추가
  if (action === 'create_user') {
    const { email, password, name, department, position, role } = body;
    if (!email || !password || !name || !role) {
      return { statusCode: 400, body: JSON.stringify({ error: '필수 항목 누락' }) };
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
      department: department || null,
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

    const canViewPw = role === 'admin';
    const { error } = await sbAdmin.from('user_roles').update({ role, can_view_password: canViewPw }).eq('id', id);
    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: '알 수 없는 action' }) };
};
