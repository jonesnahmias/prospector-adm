import { getStore } from '@netlify/blobs';
import { requireAuth, hashPassword, publicUser, corsHeaders, normalizeUserRecord, normalizeEmpresaId, empresaNomePadrao, createToken } from './_auth.js';

const headers = corsHeaders('GET, POST, OPTIONS');
function envUsers(){
  const empresaId = process.env.PROSPECTOR_EMPRESA_ID || 'philar';
  const empresaNome = process.env.PROSPECTOR_EMPRESA_NOME || 'PHILAR';
  const users = [];
  if(process.env.PROSPECTOR_ADMIN_EMAIL && process.env.PROSPECTOR_ADMIN_PASSWORD){
    users.push({email:process.env.PROSPECTOR_ADMIN_EMAIL.toLowerCase(),role:'superadmin',passwordHash:hashPassword(process.env.PROSPECTOR_ADMIN_PASSWORD),obrasPermitidas:[],empresaId,empresaNome});
  }
  if(process.env.PROSPECTOR_CAMPO_EMAIL && process.env.PROSPECTOR_CAMPO_PASSWORD){
    users.push({email:process.env.PROSPECTOR_CAMPO_EMAIL.toLowerCase(),role:'campo',passwordHash:hashPassword(process.env.PROSPECTOR_CAMPO_PASSWORD),obrasPermitidas:[],empresaId,empresaNome});
  }
  return users.map(u=>normalizeUserRecord(u));
}
async function loadUsers(store){
  let raw=[];
  try{ const data=await store.get('lista',{type:'json'}); if(Array.isArray(data)&&data.length) raw=data; }catch(e){}
  if(!raw.length) raw=envUsers();
  let normalized=raw.map(u=>normalizeUserRecord(u,{migrateLegacyAdmin:true})).filter(u=>u.email && u.passwordHash);
  envUsers().forEach(e=>{
    const old=normalized.find(u=>u.email===e.email);
    normalized=normalized.filter(u=>u.email!==e.email);
    normalized.push(normalizeUserRecord({...e, empresaId:old?.empresaId||e.empresaId, empresaNome:old?.empresaNome||e.empresaNome}));
  });
  await store.set('lista',JSON.stringify(normalized));
  return normalized;
}

function canManageCompany(actor, empresaId){
  if(actor.role === 'superadmin') return true;
  return normalizeEmpresaId(actor.empresaId) === normalizeEmpresaId(empresaId);
}

function companyLimit(users, empresaId){
  const id=normalizeEmpresaId(empresaId);
  const vals=users.filter(u=>normalizeEmpresaId(u.empresaId)===id).map(u=>Number(u.limiteUsuarios||0)).filter(n=>n>0);
  return vals.length ? Math.max(...vals) : 0;
}

function applyCompanyLimit(users, empresaId, limite){
  const id=normalizeEmpresaId(empresaId);
  const n=Math.max(0, Number(limite||0));
  return users.map(u=>normalizeEmpresaId(u.empresaId)===id?normalizeUserRecord({...u,limiteUsuarios:n}):u);
}

async function purgeCompanyData(empresaId){
  const id=normalizeEmpresaId(empresaId);
  if(!id) return;
  const stores=['obras','perfil','historico','arquivos','fotos'];
  for(const name of stores){
    const s=getStore({name,consistency:'strong'});
    const prefixes=['empresa__'+id+'__','backup__'+id+'__'];
    for(const prefix of prefixes){
      try{
        let cursor;
        for(let safety=0;safety<100;safety++){
          const page=await s.list(cursor?{cursor,prefix}:{prefix});
          const blobs=Array.isArray(page?.blobs)?page.blobs:[];
          await Promise.allSettled(blobs.map(b=>b&&b.key?s.delete(b.key):null));
          cursor=page?.cursor||page?.nextCursor||page?.next_cursor||null;
          if(!cursor) break;
        }
      }catch(e){}
    }
  }
}

export default async (req)=>{
  const store=getStore({name:'usuarios',consistency:'strong'});
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
  const gate=requireAuth(req,headers,'admin');
  if(gate.error) return gate.error;
  const actor = gate.user;

  if(req.method==='GET'){
    const users=await loadUsers(store);
    const visible = actor.role === 'superadmin' ? users : users.filter(u=>normalizeEmpresaId(u.empresaId)===normalizeEmpresaId(actor.empresaId));
    return new Response(JSON.stringify({users:visible.map(publicUser), current:publicUser(actor)}),{status:200,headers});
  }
  if(req.method==='POST'){
    try{
      const body=await req.json();
      let users=await loadUsers(store);
      if(body.action==='delete'){
        const email=String(body.email||'').toLowerCase();
        const target=users.find(u=>String(u.email||'').toLowerCase()===email);
        if(!target) return new Response(JSON.stringify({ok:true,users:users.map(publicUser)}),{status:200,headers});
        if(!canManageCompany(actor,target.empresaId)) return new Response(JSON.stringify({error:'Você não pode remover usuário de outra empresa.'}),{status:403,headers});
        users=users.filter(u=>String(u.email||'').toLowerCase()!==email);
        const sameCompanyAdmins=users.filter(u=>normalizeEmpresaId(u.empresaId)===normalizeEmpresaId(target.empresaId) && (u.role==='admin'||u.role==='superadmin'));
        if(!sameCompanyAdmins.length) return new Response(JSON.stringify({error:'É necessário manter pelo menos um administrador nesta empresa.'}),{status:400,headers});
        await store.set('lista',JSON.stringify(users));
        const visible = actor.role === 'superadmin' ? users : users.filter(u=>normalizeEmpresaId(u.empresaId)===normalizeEmpresaId(actor.empresaId));
        return new Response(JSON.stringify({ok:true,users:visible.map(publicUser)}),{status:200,headers});
      }
      if(body.action==='switchCompany'){
        if(actor.role!=='superadmin') return new Response(JSON.stringify({error:'Somente superadmin pode trocar o ambiente ativo.'}),{status:403,headers});
        const empresaId=normalizeEmpresaId(body.empresaId||actor.empresaId);
        const empresaNome=empresaNomePadrao(body.empresaNome,empresaId);
        users=users.map(u=>u.email===actor.email?normalizeUserRecord({...u,empresaId,empresaNome}):u);
        await store.set('lista',JSON.stringify(users));
        const updated=users.find(u=>u.email===actor.email);
        const token=createToken(updated);
        return new Response(JSON.stringify({ok:true,token,user:publicUser(updated)}),{status:200,headers});
      }
      if(body.action==='deleteCompany'){
        if(actor.role!=='superadmin') return new Response(JSON.stringify({error:'Somente superadmin pode excluir empresas.'}),{status:403,headers});
        const empresaId=normalizeEmpresaId(body.empresaId||'');
        if(!empresaId) return new Response(JSON.stringify({error:'Informe a empresa.'}),{status:400,headers});
        if(empresaId===normalizeEmpresaId(actor.empresaId)) return new Response(JSON.stringify({error:'Troque para outro ambiente antes de excluir a empresa atual.'}),{status:400,headers});
        users=users.filter(u=>normalizeEmpresaId(u.empresaId)!==empresaId);
        await store.set('lista',JSON.stringify(users));
        await purgeCompanyData(empresaId);
        return new Response(JSON.stringify({ok:true,users:users.map(publicUser)}),{status:200,headers});
      }
      if(body.action==='setCompanyLimit'){
        if(actor.role!=='superadmin') return new Response(JSON.stringify({error:'Somente superadmin pode definir limite de usuários.'}),{status:403,headers});
        const empresaId=normalizeEmpresaId(body.empresaId||'');
        if(!empresaId) return new Response(JSON.stringify({error:'Informe a empresa.'}),{status:400,headers});
        const limite=Math.max(0, Number(body.limiteUsuarios||0));
        const total=users.filter(u=>normalizeEmpresaId(u.empresaId)===empresaId).length;
        if(limite>0 && limite<total) return new Response(JSON.stringify({error:'O limite não pode ser menor que os '+total+' usuário(s) já cadastrados.'}),{status:400,headers});
        users=applyCompanyLimit(users,empresaId,limite);
        await store.set('lista',JSON.stringify(users));
        return new Response(JSON.stringify({ok:true,users:users.map(publicUser)}),{status:200,headers});
      }
      const u=body.user||{};
      const email=String(u.email||'').trim().toLowerCase();
      if(!email) return new Response(JSON.stringify({error:'E-mail obrigatório'}),{status:400,headers});
      const old=users.find(x=>String(x.email||'').toLowerCase()===email)||{};
      let empresaId = actor.role === 'superadmin' ? normalizeEmpresaId(u.empresaId || old.empresaId || actor.empresaId || 'philar') : normalizeEmpresaId(actor.empresaId);
      if(!canManageCompany(actor,empresaId)) return new Response(JSON.stringify({error:'Você não pode cadastrar usuário em outra empresa.'}),{status:403,headers});
      let role = u.role === 'superadmin' ? 'superadmin' : (u.role === 'admin' ? 'admin' : 'campo');
      if(actor.role !== 'superadmin' && role === 'superadmin') role = 'admin';
      const isNewUser=!old.email;
      const limiteAtual=companyLimit(users,empresaId);
      const totalEmpresa=users.filter(x=>normalizeEmpresaId(x.empresaId)===empresaId).length;
      if(isNewUser && limiteAtual>0 && totalEmpresa>=limiteAtual){
        return new Response(JSON.stringify({error:'Limite de usuários atingido para esta empresa ('+totalEmpresa+'/'+limiteAtual+').'}),{status:400,headers});
      }
      const limiteUsuario = actor.role === 'superadmin' ? Math.max(0, Number(u.limiteUsuarios || old.limiteUsuarios || limiteAtual || 0)) : (old.limiteUsuarios || limiteAtual || 0);
      const item=normalizeUserRecord({
        email,
        role,
        passwordHash:u.password?hashPassword(u.password):old.passwordHash,
        obrasPermitidas:Array.isArray(u.obrasPermitidas)?u.obrasPermitidas.map(String).filter(Boolean):[],
        empresaId,
        empresaNome:empresaNomePadrao(u.empresaNome || old.empresaNome, empresaId),
        limiteUsuarios:limiteUsuario
      });
      if(!item.passwordHash) return new Response(JSON.stringify({error:'Senha obrigatória'}),{status:400,headers});
      users=users.filter(x=>String(x.email||'').toLowerCase()!==email);
      users.push(item);
      users=applyCompanyLimit(users,empresaId,limiteUsuario);
      await store.set('lista',JSON.stringify(users));
      const visible = actor.role === 'superadmin' ? users : users.filter(u=>normalizeEmpresaId(u.empresaId)===normalizeEmpresaId(actor.empresaId));
      return new Response(JSON.stringify({ok:true,users:visible.map(publicUser)}),{status:200,headers});
    }catch(e){ return new Response(JSON.stringify({error:e.message}),{status:500,headers}); }
  }
  return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers});
};
export const config = { path:'/api/usuarios' };
