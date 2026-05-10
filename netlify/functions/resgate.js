import { getStore } from '@netlify/blobs';
import { requireAuth, corsHeaders, setTenantJson } from './_auth.js';

const headers = {
  ...corsHeaders('GET, POST, OPTIONS'),
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
};

function pareceObra(o){
  if(!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const campos=['nome','titulo','cliente','contrato','status','diario','gastos','medicoes','orcamento','orcamento_obra','projeto','projetoAnalise','area','local','cidade','endereco','valorEstimado','valorContratado'];
  return campos.some(k=>Object.prototype.hasOwnProperty.call(o,k));
}
function normalizarLista(v){
  return Array.isArray(v) ? v.filter(o=>o && typeof o==='object' && pareceObra(o)) : [];
}
async function tentarJson(store,key){
  try{ return await store.get(key,{type:'json'}); }catch(e){ return null; }
}
async function listarChaves(store){
  const known = new Set([
    'lista',
    'empresa__default__lista',
    'empresa__philar__lista',
    'backup__philar__lista__last_nonempty',
    'backup__default__lista__last_nonempty'
  ]);
  try{
    let cursor;
    for(let safety=0;safety<20;safety++){
      const page = await store.list(cursor ? {cursor} : {});
      const blobs = Array.isArray(page?.blobs) ? page.blobs : [];
      blobs.forEach(b=>{ if(b && b.key) known.add(String(b.key)); });
      cursor = page?.cursor || page?.nextCursor || page?.next_cursor || null;
      if(!cursor) break;
    }
  }catch(e){}
  return Array.from(known);
}
async function candidatosObras(){
  const store=getStore({name:'obras',consistency:'strong'});
  const keys=await listarChaves(store);
  const out=[];
  for(const key of keys){
    if(!/(^lista$|__lista$|lista__last_nonempty$)/.test(key)) continue;
    const data=await tentarJson(store,key);
    const lista=normalizarLista(data);
    if(lista.length){
      out.push({
        key,
        count:lista.length,
        nomes:lista.slice(0,5).map(o=>String(o.nome||o.titulo||o.contrato||o.id||'Obra sem nome'))
      });
    }
  }
  return out.sort((a,b)=>b.count-a.count);
}

export default async (req)=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
  const gate=requireAuth(req,headers,'superadmin');
  if(gate.error) return gate.error;
  const user=gate.user;

  if(req.method==='GET'){
    const url=new URL(req.url);
    const tipo=url.searchParams.get('tipo')||'obras';
    if(tipo!=='obras') return new Response(JSON.stringify({candidatos:[]}),{status:200,headers});
    const candidatos=await candidatosObras();
    return new Response(JSON.stringify({ok:true,tipo,candidatos}),{status:200,headers});
  }

  if(req.method==='POST'){
    try{
      const body=await req.json();
      if((body.tipo||'obras')!=='obras') return new Response(JSON.stringify({error:'Tipo de resgate inválido.'}),{status:400,headers});
      const sourceKey=String(body.sourceKey||'').trim();
      if(!sourceKey) return new Response(JSON.stringify({error:'Informe a chave de origem.'}),{status:400,headers});
      const store=getStore({name:'obras',consistency:'strong'});
      const data=await tentarJson(store,sourceKey);
      const lista=normalizarLista(data);
      if(!lista.length) return new Response(JSON.stringify({error:'A chave indicada não contém obras válidas.'}),{status:404,headers});
      await setTenantJson(store,user,'lista',lista);
      return new Response(JSON.stringify({ok:true,count:lista.length,sourceKey}),{status:200,headers});
    }catch(e){
      return new Response(JSON.stringify({error:e.message}),{status:500,headers});
    }
  }
  return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers});
};

export const config = { path:'/api/resgate' };
