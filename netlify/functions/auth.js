import { getStore } from '@netlify/blobs';
import { createToken, getAuthUser, hashPassword, publicUser, corsHeaders, normalizeUserRecord } from './_auth.js';

const headers = corsHeaders('GET, POST, OPTIONS');

function envUsers(){
  const empresaId = process.env.PROSPECTOR_EMPRESA_ID || 'philar';
  const empresaNome = process.env.PROSPECTOR_EMPRESA_NOME || 'PHILAR';
  const users = [];
  if(process.env.PROSPECTOR_ADMIN_EMAIL && process.env.PROSPECTOR_ADMIN_PASSWORD){
    users.push({
      email:process.env.PROSPECTOR_ADMIN_EMAIL.toLowerCase(),
      role:'superadmin',
      passwordHash:hashPassword(process.env.PROSPECTOR_ADMIN_PASSWORD),
      obrasPermitidas:[],
      empresaId,
      empresaNome
    });
  }
  if(process.env.PROSPECTOR_CAMPO_EMAIL && process.env.PROSPECTOR_CAMPO_PASSWORD){
    users.push({
      email:process.env.PROSPECTOR_CAMPO_EMAIL.toLowerCase(),
      role:'campo',
      passwordHash:hashPassword(process.env.PROSPECTOR_CAMPO_PASSWORD),
      obrasPermitidas:[],
      empresaId,
      empresaNome
    });
  }
  return users.map(u=>normalizeUserRecord(u));
}

async function loadUsers(){
  const store=getStore({name:'usuarios',consistency:'strong'});
  try{
    const data=await store.get('lista',{type:'json'});
    if(Array.isArray(data) && data.length){
      let normalized = data.map(u=>normalizeUserRecord(u,{migrateLegacyAdmin:true})).filter(u=>u.email && u.passwordHash);
      const env = envUsers();
      env.forEach(e=>{
        const old = normalized.find(u=>u.email===e.email);
        normalized = normalized.filter(u=>u.email!==e.email);
        normalized.push(normalizeUserRecord({...e, empresaId:old?.empresaId||e.empresaId, empresaNome:old?.empresaNome||e.empresaNome}));
      });
      try{ await store.set('lista',JSON.stringify(normalized)); }catch(e){}
      return normalized;
    }
  }catch(e){}
  const defaults=envUsers();
  try{ await store.set('lista',JSON.stringify(defaults)); }catch(e){}
  return defaults;
}

export default async (req)=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});

  if(req.method==='GET'){
    const user=getAuthUser(req);
    if(!user) return new Response(JSON.stringify({error:'Sessão inválida'}),{status:401,headers});
    return new Response(JSON.stringify({ok:true,user:publicUser(user)}),{status:200,headers});
  }

  if(req.method==='POST'){
    try{
      const body=await req.json();
      const email=String(body.email||'').trim().toLowerCase();
      const password=String(body.password||'');
      if(!email || !password) return new Response(JSON.stringify({error:'E-mail e senha obrigatórios'}),{status:400,headers});
      const users=await loadUsers();
      const u=users.find(x=>String(x.email||'').toLowerCase()===email);
      if(!u || u.passwordHash!==hashPassword(password)) return new Response(JSON.stringify({error:'E-mail ou senha inválidos'}),{status:401,headers});
      const user=normalizeUserRecord(u);
      const token=createToken(user);
      return new Response(JSON.stringify({ok:true,token,user:publicUser(user)}),{status:200,headers});
    }catch(e){
      return new Response(JSON.stringify({error:e.message}),{status:500,headers});
    }
  }

  return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers});
};
export const config = { path:'/api/auth' };
