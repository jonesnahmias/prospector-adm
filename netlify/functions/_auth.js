import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_SECRET = 'prospector-dev-secret-change-in-netlify';
const ROLE_LEVEL = { campo: 1, admin: 2, superadmin: 3 };
const LEGACY_DEFAULT_EMPRESA_ID = 'default';
const PHILAR_EMPRESA_ID = 'philar';
const PHILAR_EMPRESA_NOME = 'PHILAR';

function secret(){ return process.env.PROSPECTOR_AUTH_SECRET || DEFAULT_SECRET; }
function b64url(input){ return Buffer.from(input).toString('base64url'); }
function sign(data){ return createHmac('sha256', secret()).update(data).digest('base64url'); }
function safeEqual(a,b){
  try{
    const A=Buffer.from(String(a)); const B=Buffer.from(String(b));
    if(A.length!==B.length) return false;
    return timingSafeEqual(A,B);
  }catch(e){ return false; }
}

export function normalizeEmpresaId(value){
  let s = String(value || PHILAR_EMPRESA_ID).trim().toLowerCase();
  try{ s = s.normalize('NFD').replace(/[\u0300-\u036f]/g,''); }catch(e){}
  s = s.replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
  // Migração oficial: o ambiente antigo "default" passa a ser tratado como PHILAR.
  // Isso preserva os dados já cadastrados sem exigir recadastro ou importação.
  if(!s || s === LEGACY_DEFAULT_EMPRESA_ID) return PHILAR_EMPRESA_ID;
  return s;
}

export function empresaNomePadrao(value, id){
  const nome = String(value || '').trim();
  if(nome && nome !== 'Empresa principal') return nome;
  const eid = normalizeEmpresaId(id);
  if(eid === PHILAR_EMPRESA_ID) return PHILAR_EMPRESA_NOME;
  return eid.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function normalizeRole(role){
  if(role === 'superadmin') return 'superadmin';
  if(role === 'admin') return 'admin';
  return 'campo';
}

export function hashPassword(password){
  return createHmac('sha256', secret()).update(String(password||'')).digest('base64url');
}

export function normalizeUserRecord(u, opts={}){
  u = u && typeof u === 'object' ? u : {};
  const hadEmpresa = !!u.empresaId;
  let role = normalizeRole(u.role);
  // Migração: administradores antigos do app de empresa única viram Super Admin,
  // para que o dono do sistema consiga criar e administrar outros ambientes.
  if(opts.migrateLegacyAdmin && role === 'admin' && !hadEmpresa) role = 'superadmin';
  const empresaId = normalizeEmpresaId(u.empresaId || opts.empresaId || PHILAR_EMPRESA_ID);
  return {
    email: String(u.email || '').trim().toLowerCase(),
    role,
    passwordHash: u.passwordHash || '',
    obrasPermitidas: Array.isArray(u.obrasPermitidas) ? u.obrasPermitidas.map(String).filter(Boolean) : [],
    empresaId,
    empresaNome: empresaNomePadrao(u.empresaNome || opts.empresaNome, empresaId),
    limiteUsuarios: Math.max(0, Number(u.limiteUsuarios || opts.limiteUsuarios || 0))
  };
}

export function createToken(user){
  const u = normalizeUserRecord(user || {});
  const payload={
    email:u.email,
    role:u.role,
    obrasPermitidas:Array.isArray(u.obrasPermitidas)?u.obrasPermitidas:[],
    empresaId:u.empresaId,
    empresaNome:u.empresaNome,
    limiteUsuarios:u.limiteUsuarios||0,
    iat:Date.now(),
    exp:Date.now()+1000*60*60*12
  };
  const body=b64url(JSON.stringify(payload));
  return body+'.'+sign(body);
}

export function verifyToken(token){
  if(!token || typeof token!=='string' || !token.includes('.')) return null;
  const [body,sig]=token.split('.');
  if(!safeEqual(sig,sign(body))) return null;
  try{
    const raw=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!raw.exp || Date.now()>raw.exp) return null;
    return normalizeUserRecord(raw);
  }catch(e){ return null; }
}

export function getAuthUser(req){
  const auth=req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const token=auth.toLowerCase().startsWith('bearer ')?auth.slice(7).trim():'';
  return verifyToken(token);
}

export function hasRole(user, role){
  if(!user) return false;
  return (ROLE_LEVEL[normalizeRole(user.role)]||0) >= (ROLE_LEVEL[role]||0);
}

export function allowedObra(user, obraId){
  if(!user) return false;
  if(user.role==='admin' || user.role==='superadmin') return true;
  const lista=Array.isArray(user.obrasPermitidas)?user.obrasPermitidas.filter(Boolean):[];
  if(!lista.length) return true;
  return lista.includes(String(obraId));
}

export function authError(headers, msg='Acesso não autorizado', status=401){
  return new Response(JSON.stringify({error:msg}),{status,headers});
}

export function requireAuth(req, headers, minRole='campo'){
  const user=getAuthUser(req);
  if(!user) return { error: authError(headers, 'Faça login para continuar.', 401) };
  if(!hasRole(user,minRole)) return { error: authError(headers, 'Perfil sem permissão para esta área.', 403) };
  return { user };
}

export function corsHeaders(methods='GET, POST, OPTIONS'){
  return {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers':'Content-Type, Authorization'
  };
}

export function publicUser(u){
  const user = normalizeUserRecord(u || {});
  return { email:user.email, role:user.role, obrasPermitidas:user.obrasPermitidas, empresaId:user.empresaId, empresaNome:user.empresaNome, limiteUsuarios:user.limiteUsuarios||0 };
}

export function tenantKeys(user, key){
  const empresaId = normalizeEmpresaId(user && user.empresaId);
  if(empresaId === PHILAR_EMPRESA_ID){
    // Compatibilidade de migração PHILAR:
    // - key simples: usado nas versões de empresa única;
    // - empresa__philar__: usado no multiempresa atual;
    // - empresa__default__: usado por versões intermediárias antes da migração default -> philar;
    // - backup__philar__: cópia de segurança automática do último valor não vazio.
    return [
      key,
      'empresa__' + PHILAR_EMPRESA_ID + '__' + key,
      'empresa__' + LEGACY_DEFAULT_EMPRESA_ID + '__' + key,
      'backup__' + PHILAR_EMPRESA_ID + '__' + key + '__last_nonempty'
    ];
  }
  return ['empresa__' + empresaId + '__' + key, 'backup__' + empresaId + '__' + key + '__last_nonempty'];
}

export function tenantKey(user, key){
  return tenantKeys(user, key)[0];
}

function isMeaningfulTenantData(data){
  if(data === null || data === undefined) return false;
  if(Array.isArray(data)) return data.length > 0;
  if(typeof data === 'object') return Object.keys(data).length > 0;
  return String(data).length > 0;
}

export async function getTenantJson(store, user, key, fallbackValue=null){
  let emptyFound = null;
  for(const k of tenantKeys(user, key)){
    try{
      const data = await store.get(k, { type:'json' });
      if(isMeaningfulTenantData(data)) return data;
      if(data !== null && data !== undefined && emptyFound === null) emptyFound = data;
    }catch(e){}
  }
  return emptyFound !== null ? emptyFound : fallbackValue;
}

export async function setTenantJson(store, user, key, value){
  const payload = JSON.stringify(value);
  const empresaId = normalizeEmpresaId(user && user.empresaId);
  const meaningful = isMeaningfulTenantData(value);
  let keys = tenantKeys(user, key);

  // Proteção da migração: nunca gravar array/objeto vazio por cima das chaves antigas
  // da PHILAR. Isso evita que uma tela nova vazia apague dados já existentes em "lista",
  // "empresa", "ia" ou "index" durante o primeiro acesso multiempresa.
  if(empresaId === PHILAR_EMPRESA_ID && !meaningful){
    keys = ['empresa__' + PHILAR_EMPRESA_ID + '__' + key];
  }else{
    // Quando houver dados reais, manter uma cópia de segurança para recuperação futura.
    const backupKey = 'backup__' + empresaId + '__' + key + '__last_nonempty';
    if(!keys.includes(backupKey)) keys.push(backupKey);
  }
  await Promise.allSettled(keys.map(k => store.set(k, payload)));
}

export async function deleteTenantKey(store, user, key){
  await Promise.allSettled(tenantKeys(user, key).map(k => store.delete(k)));
}
