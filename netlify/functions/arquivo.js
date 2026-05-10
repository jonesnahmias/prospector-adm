import { getStore } from "@netlify/blobs";
import { requireAuth, corsHeaders, tenantKey, tenantKeys, getTenantJson, setTenantJson, deleteTenantKey } from './_auth.js';

export default async (req) => {
  const store = getStore({ name: "arquivos", consistency: "strong" });
  const headers = corsHeaders("GET, POST, DELETE, OPTIONS");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, 'admin');
  if (gate.error) return gate.error;
  const user = gate.user;

  async function getIndex() {
    try {
      const idx = await getTenantJson(store, user, "index", []);
      return Array.isArray(idx) ? idx : [];
    } catch (e) { return []; }
  }
  async function setIndex(idx) { await setTenantJson(store, user, "index", Array.isArray(idx) ? idx : []); }
  function onlyMeta(file) {
    return {
      id: file.id,
      nome: file.nome || "arquivo",
      modulo: file.modulo || "geral",
      tipo: file.tipo || file.mime || "",
      mime: file.mime || file.tipo || "",
      tamanho: file.tamanho || 0,
      data: file.data || new Date().toISOString(),
      obraId: file.obraId || "",
      obraNome: file.obraNome || "",
      chars: file.chars || (file.textoExtraido ? String(file.textoExtraido).length : 0),
      temTexto: !!file.textoExtraido,
      temArquivo: !!file.dataUrl,
      origem: file.origem || "upload",
      assinatura: file.assinatura || ""
    };
  }

  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (id) {
        let file = null;
        for (const k of tenantKeys(user, "arquivo-" + id)) { try { file = await store.get(k, { type: "json" }); if (file) break; } catch(e){} }
        return new Response(JSON.stringify(file || null), { status: 200, headers });
      }
      const idx = await getIndex();
      return new Response(JSON.stringify({ arquivos: idx }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ arquivos: [], error: e.message }), { status: 200, headers });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!body || !body.id || !body.nome) return new Response(JSON.stringify({ error: "id e nome obrigatórios" }), { status: 400, headers });
      const file = {
        id: body.id,
        nome: body.nome,
        modulo: body.modulo || "geral",
        tipo: body.tipo || body.mime || "",
        mime: body.mime || body.tipo || "",
        tamanho: body.tamanho || 0,
        data: body.data || new Date().toISOString(),
        obraId: body.obraId || "",
        obraNome: body.obraNome || "",
        textoExtraido: body.textoExtraido || "",
        chars: body.chars || (body.textoExtraido ? String(body.textoExtraido).length : 0),
        dataUrl: body.dataUrl || "",
        origem: body.origem || "upload",
        assinatura: body.assinatura || ""
      };
      await Promise.allSettled(tenantKeys(user, "arquivo-" + file.id).map(k => store.set(k, JSON.stringify(file))));
      let idx = await getIndex();
      idx = idx.filter((x) => {
        if (!x || x.id === file.id) return false;
        if (file.assinatura && x.assinatura === file.assinatura) return false;
        const sameFile = (x.modulo || "") === file.modulo && (x.obraId || "") === file.obraId && (x.nome || "") === file.nome && Number(x.tamanho || 0) === Number(file.tamanho || 0) && Number(x.chars || 0) === Number(file.chars || 0);
        return !sameFile;
      });
      idx.unshift(onlyMeta(file));
      idx = idx.slice(0, 1000);
      await setIndex(idx);
      return new Response(JSON.stringify({ ok: true, arquivo: onlyMeta(file) }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  if (req.method === "DELETE") {
    try {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return new Response(JSON.stringify({ error: "id obrigatório" }), { status: 400, headers });
      await deleteTenantKey(store, user, "arquivo-" + id);
      let idx = await getIndex();
      idx = idx.filter((x) => x && x.id !== id);
      await setIndex(idx);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/arquivo" };
