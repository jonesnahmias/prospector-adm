import { getStore } from "@netlify/blobs";
import { requireAuth, allowedObra, corsHeaders, getTenantJson, setTenantJson, normalizeEmpresaId } from './_auth.js';

const headers = {
  ...corsHeaders("GET, POST, OPTIONS"),
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
};

function campoView(o){
  return {
    id:o.id,
    nome:o.nome || o.titulo || 'Obra sem nome',
    titulo:o.titulo || o.nome || '',
    tipo:o.tipo || o.tipoObra || '',
    tipoObra:o.tipoObra || o.tipo || '',
    cliente:o.cliente || '',
    contratante:o.contratante || o.cliente || '',
    local:o.local || o.cidade || o.endereco || '',
    cidade:o.cidade || o.municipio || '',
    municipio:o.municipio || o.cidade || '',
    endereco:o.endereco || o.end || '',
    end:o.end || o.endereco || '',
    status:o.status || '',
    contrato:o.contrato || o.contratoProcesso || o.numeroContrato || o.processo || '',
    contratoProcesso:o.contratoProcesso || o.contrato || o.numeroContrato || o.processo || '',
    numeroContrato:o.numeroContrato || o.contrato || o.contratoProcesso || '',
    processo:o.processo || o.contratoProcesso || o.contrato || '',
    valorEstimado:o.valorEstimado || o.valorBase || o.orcamentoTotal || '',
    valorContratado:o.valorContratado || '',
    valorBase:o.valorBase || o.valorEstimado || o.orcamentoTotal || '',
    area:o.area || o.areaTotal || '',
    faseAtual:o.faseAtual || '',
    descricao:o.descricao || o.escopo || '',
    escopo:o.escopo || o.descricao || '',
    documentosConsulta:sanitizeDocsConsultaObra(o.documentosConsulta || o.documentosConsultaDiario || o.docsConsulta),
    dataInicio:o.dataInicio || o.inicio || '',
    dataFim:o.dataFim || o.fim || '',
    diario:Array.isArray(o.diario)?o.diario.filter(d=>!(d && (d._deleted===true || d.excluido===true))):[]
  };
}

function isCentroFinanceiro(o){
  return o?.centroFinanceiro === true || String(o?.tipoCentro || '').trim() !== '';
}

function novoId(prefix='id'){
  return prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
}

function empresaObra(o){
  return normalizeEmpresaId(o?.empresaId || o?.empresa_id || o?.tenantId || '');
}

function obraPertenceAoTenant(o, user){
  const userEmpresa = normalizeEmpresaId(user?.empresaId);
  const obraEmpresaRaw = o?.empresaId || o?.empresa_id || o?.tenantId || '';
  if(!obraEmpresaRaw){
    // Compatibilidade: obras antigas sem empresa marcada pertencem apenas ao ambiente PHILAR.
    return userEmpresa === 'philar';
  }
  return empresaObra(o) === userEmpresa;
}

function filtrarObrasTenant(lista, user){
  return (Array.isArray(lista) ? lista : []).filter(o => obraPertenceAoTenant(o, user));
}

function marcarObraTenant(o, user){
  const empresaId = normalizeEmpresaId(user?.empresaId);
  const raw = o?.empresaId || o?.empresa_id || o?.tenantId || '';
  if(raw) return { ...(o || {}), empresaId: normalizeEmpresaId(raw) };
  return { ...(o || {}), empresaId };
}

function sanitizeDocApoio(doc){
  if(!doc || typeof doc !== 'object') return null;
  return {
    id: String(doc.id || novoId('doc')),
    nome: String(doc.nome || doc.name || 'arquivo'),
    mime: String(doc.mime || doc.type || ''),
    tamanho: Number(doc.tamanho || doc.size || 0),
    dataUrl: String(doc.dataUrl || doc.data || ''),
    data: String(doc.data || doc.criadoEm || new Date().toISOString()),
    categoria: String(doc.categoria || '')
  };
}

function sanitizeDocsApoio(documentosApoio){
  const docs = documentosApoio && typeof documentosApoio === 'object' ? documentosApoio : {};
  return {
    projetos: Array.isArray(docs.projetos) ? docs.projetos.map(sanitizeDocApoio).filter(Boolean).slice(0,20) : [],
    orcamentos: Array.isArray(docs.orcamentos) ? docs.orcamentos.map(sanitizeDocApoio).filter(Boolean).slice(0,20) : []
  };
}

function sanitizeDocsConsultaObra(documentosConsulta){
  const docs = documentosConsulta && typeof documentosConsulta === 'object' ? documentosConsulta : {};
  return {
    projetos: Array.isArray(docs.projetos) ? docs.projetos.map(sanitizeDocApoio).filter(Boolean).slice(0,60) : [],
    orcamentos: Array.isArray(docs.orcamentos) ? docs.orcamentos.map(sanitizeDocApoio).filter(Boolean).slice(0,60) : []
  };
}

function mergeById(current=[], incoming=[], limit=2000){
  const map = new Map();
  const put = (item, prefer=false) => {
    if(!item || typeof item !== 'object') return;
    const id = String(item.id || novoId('item'));
    const prev = map.get(id) || {};
    map.set(id, prefer ? {...prev, ...item, id} : {...item, id});
  };
  current.forEach(x=>put(x,false));
  incoming.forEach(x=>put(x,true));
  return Array.from(map.values()).slice(-limit);
}

function mergeDocsApoio(curDocs, incDocs){
  const cur = sanitizeDocsApoio(curDocs);
  const inc = sanitizeDocsApoio(incDocs);
  return {
    projetos: mergeById(cur.projetos, inc.projetos, 20),
    orcamentos: mergeById(cur.orcamentos, inc.orcamentos, 20)
  };
}

function mergeDocsConsultaObra(curDocs, incDocs){
  const cur = sanitizeDocsConsultaObra(curDocs);
  const inc = sanitizeDocsConsultaObra(incDocs);
  return {
    projetos: mergeById(cur.projetos, inc.projetos, 60),
    orcamentos: mergeById(cur.orcamentos, inc.orcamentos, 60)
  };
}

function sanitizeDiario(d, user){
  if(!d || typeof d !== 'object') return null;
  const removido = d._deleted === true || d.excluido === true;
  return {
    id:String(d.id||novoId('diario')),
    _deleted: removido,
    excluido: removido,
    excluidoEm: String(d.excluidoEm||''),
    excluidoPor: String(d.excluidoPor||user?.email||''),
    data:String(d.data||''),
    clima:String(d.clima||''),
    temperatura:String(d.temperatura||''),
    resp:String(d.resp||''),
    efetivo:d.efetivo && typeof d.efetivo==='object' ? d.efetivo : {},
    servicos:String(d.servicos||''),
    materiais:String(d.materiais||''),
    equipamentos:String(d.equipamentos||''),
    ocorrencias:String(d.ocorrencias||''),
    obs:String(d.obs||''),
    fotos:Array.isArray(d.fotos)?d.fotos:[],
    fotosLocal:Array.isArray(d.fotosLocal)?d.fotosLocal:[],
    criadoPor:String(d.criadoPor||user?.email||''),
    atualizadoPor:String(d.atualizadoPor||user?.email||''),
    atualizadoEm:String(d.atualizadoEm||new Date().toISOString())
  };
}

function mergeDiarioList(currentList, incomingList, user){
  const map = new Map();
  const put = (raw, preferIncoming) => {
    const d = sanitizeDiario(raw, user);
    if(!d) return;
    if(d._deleted || d.excluido){
      if(preferIncoming) map.delete(d.id);
      return;
    }
    delete d._deleted;
    delete d.excluido;
    const prev = map.get(d.id);
    if(!prev){
      map.set(d.id, d);
      return;
    }
    const merged = preferIncoming ? {...prev, ...d} : {...d, ...prev};
    merged.fotos = mergeById(
      (Array.isArray(prev.fotos)?prev.fotos:[]).map(x=>typeof x==='object'?x:{id:String(x),valor:x}),
      (Array.isArray(d.fotos)?d.fotos:[]).map(x=>typeof x==='object'?x:{id:String(x),valor:x}),
      60
    ).map(x=>x.valor!==undefined?x.valor:x);
    merged.fotosLocal = mergeById(prev.fotosLocal||[], d.fotosLocal||[], 60);
    merged.atualizadoEm = new Date().toISOString();
    map.set(d.id, merged);
  };
  (Array.isArray(currentList)?currentList:[]).forEach(d=>put(d, false));
  (Array.isArray(incomingList)?incomingList:[]).forEach(d=>put(d, true));
  return Array.from(map.values()).filter(d=>!(d && (d._deleted===true || d.excluido===true))).sort((a,b)=>String(a.data||'').localeCompare(String(b.data||''))).slice(-2000);
}

function mergeHistorico(current, incoming){
  const out=[];
  const seen=new Set();
  const add=(h)=>{
    if(!h || typeof h!=='object') return;
    const data=String(h.data||'');
    const txt=String(h.txt||h.texto||'');
    const key=data+'|'+txt;
    if(!txt || seen.has(key)) return;
    seen.add(key); out.push({...h,data,txt});
  };
  (Array.isArray(current)?current:[]).forEach(add);
  (Array.isArray(incoming)?incoming:[]).forEach(add);
  return out.slice(-700);
}

function mergeObraAdmin(currentObra, incomingObra, user){
  const cur = currentObra && typeof currentObra === 'object' ? currentObra : {};
  const inc = incomingObra && typeof incomingObra === 'object' ? incomingObra : {};
  const merged = {...cur, ...inc};

  // Campo e administrador usam o mesmo local para o diário: obra.diario.
  // A mesclagem por ID evita que um lado apague registros/fotos/anexos criados pelo outro lado
  // quando a tela estiver com uma cópia antiga em memória.
  merged.diario = mergeDiarioList(cur.diario, inc.diario, user);
  merged.documentosConsulta = mergeDocsConsultaObra(cur.documentosConsulta || cur.documentosConsultaDiario || cur.docsConsulta, inc.documentosConsulta || inc.documentosConsultaDiario || inc.docsConsulta);
  merged.historico = mergeHistorico(cur.historico, inc.historico);
  merged.atualizadoEm = new Date().toISOString();
  return marcarObraTenant(merged, user);
}

function novaObraCampo(inc, user){
  const id = String(inc?.id || novoId('obra'));
  const nome = String(inc?.nome || inc?.titulo || 'Obra sem nome');
  return marcarObraTenant({
    id,
    nome,
    titulo: String(inc?.titulo || nome),
    tipo: String(inc?.tipo || inc?.tipoObra || ''),
    tipoObra: String(inc?.tipoObra || inc?.tipo || ''),
    cliente: String(inc?.cliente || inc?.contratante || ''),
    contratante: String(inc?.contratante || inc?.cliente || ''),
    local: String(inc?.local || inc?.cidade || inc?.municipio || inc?.endereco || ''),
    cidade: String(inc?.cidade || inc?.municipio || inc?.local || ''),
    municipio: String(inc?.municipio || inc?.cidade || inc?.local || ''),
    endereco: String(inc?.endereco || inc?.local || ''),
    status: String(inc?.status || 'Em ExecuÃ§Ã£o'),
    contrato: String(inc?.contrato || inc?.contratoProcesso || inc?.numeroContrato || inc?.processo || ''),
    contratoProcesso: String(inc?.contratoProcesso || inc?.contrato || inc?.numeroContrato || inc?.processo || ''),
    valorEstimado: String(inc?.valorEstimado || inc?.valorBase || ''),
    valorContratado: String(inc?.valorContratado || ''),
    area: String(inc?.area || ''),
    descricao: String(inc?.descricao || inc?.escopo || ''),
    escopo: String(inc?.escopo || inc?.descricao || ''),
    documentosConsulta: mergeDocsConsultaObra(null, inc?.documentosConsulta || inc?.documentosConsultaDiario || inc?.docsConsulta),
    diario: mergeDiarioList([], inc?.diario || [], user),
    historico: [{data:new Date().toLocaleDateString('pt-BR'),txt:'Obra criada no DiÃ¡rio por '+(user.email||'usuÃ¡rio de campo')}],
    criadoNoDiario: true,
    criadoPor: String(inc?.criadoPor || user?.email || ''),
    criadoEm: String(inc?.criadoEm || new Date().toISOString()),
    atualizadoEm: new Date().toISOString()
  }, user);
}

export default async (req) => {
  const store = getStore({ name: "obras", consistency: "strong" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, 'campo');
  if (gate.error) return gate.error;
  const user = gate.user;
  if (req.method === "GET") {
    try {
      const data = await getTenantJson(store, user, "lista", []);
      const obras = filtrarObrasTenant(data, user);
      if(user.role === 'admin' || user.role === 'superadmin') return new Response(JSON.stringify(obras), { status: 200, headers });
      const liberadas = obras.filter(o=>!isCentroFinanceiro(o) && allowedObra(user,o.id)).map(campoView);
      return new Response(JSON.stringify(liberadas), { status: 200, headers });
    } catch (e) {
      return new Response("[]", { status: 200, headers });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const incoming = filtrarObrasTenant(Array.isArray(body) ? body.map(o => marcarObraTenant(o, user)) : [], user);
      const current = await getTenantJson(store, user, "lista", []);
      const obras = filtrarObrasTenant(current, user);

      if(user.role === 'admin' || user.role === 'superadmin'){
        const currentMap = new Map(obras.map(o=>[String(o.id), o]));
        const merged = incoming.filter(inc=>!(inc && (inc._deletedObra===true || inc.excluida===true))).map(inc=>{
          const id = String(inc?.id || novoId('obra'));
          inc.id = id;
          return mergeObraAdmin(currentMap.get(id), inc, user);
        });
        await setTenantJson(store, user, "lista", merged);
        return new Response(JSON.stringify({ ok: true, count: merged.length }), { status: 200, headers });
      }

      const currentMap = new Map(obras.map(o=>[String(o.id), o]));
      const inMap = new Map(incoming.map(o=>[String(o.id),o]));
      const removidas = new Set(incoming.filter(o=>{
        if(!o || !(o._deletedObra===true || o.excluida===true) || !allowedObra(user,o.id)) return false;
        const atual = currentMap.get(String(o.id));
        return !isCentroFinanceiro(atual);
      }).map(o=>String(o.id)));
      const currentIds = new Set(obras.map(o=>String(o.id)));
      const merged = obras.filter(o=>!removidas.has(String(o.id))).map(o=>{
        const inc = inMap.get(String(o.id));
        if(!inc || !allowedObra(user,o.id)) return o;
        const oldCount = Array.isArray(o.diario) ? o.diario.length : 0;
        o.documentosConsulta = mergeDocsConsultaObra(o.documentosConsulta || o.documentosConsultaDiario || o.docsConsulta, inc.documentosConsulta || inc.documentosConsultaDiario || inc.docsConsulta);
        o.diario = mergeDiarioList(o.diario, inc.diario || [], user);
        const newCount = Array.isArray(o.diario) ? o.diario.length : 0;
        o.historico = Array.isArray(o.historico)?o.historico:[];
        o.historico.unshift({data:new Date().toLocaleDateString('pt-BR'),txt:'📔 Diário sincronizado por '+(user.email||'usuário de campo')+(newCount>oldCount?' — novo registro':'')});
        o.historico = mergeHistorico([], o.historico).slice(0,700);
        o.atualizadoEm = new Date().toISOString();
        return o;
      });
      incoming.forEach(inc=>{
        if(!inc || inc._deletedObra===true || inc.excluida===true) return;
        if(isCentroFinanceiro(inc)) return;
        const id = String(inc.id || '');
        if(!id || currentIds.has(id)) return;
        merged.unshift(novaObraCampo(inc, user));
      });
      await setTenantJson(store, user, "lista", merged);
      return new Response(JSON.stringify({ ok: true, count: merged.length }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/obras" };
