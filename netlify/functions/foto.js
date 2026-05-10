import { getStore } from "@netlify/blobs";
import { requireAuth, corsHeaders, tenantKey, tenantKeys, deleteTenantKey } from './_auth.js';

export default async (req) => {
  const store = getStore({ name: "fotos", consistency: "strong" });
  const headers = corsHeaders("GET, POST, DELETE, OPTIONS");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, 'campo');
  if (gate.error) return gate.error;
  const user = gate.user;

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!body.id || !body.data) return new Response(JSON.stringify({ error: "id e data obrigatórios" }), { status: 400, headers });
      const foto = { id: body.id, data: body.data, caption: body.caption || "", nome: body.nome || "", obraId: body.obraId || "", criadoPor: gate.user.email || "", criadoEm: new Date().toISOString() };
      await Promise.allSettled(tenantKeys(user, "foto-" + body.id).map(k => store.set(k, JSON.stringify(foto))));
      return new Response(JSON.stringify({ ok: true, id: body.id }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (id && id.includes(",")) {
        const ids = id.split(",").filter(Boolean);
        const fotos = await Promise.all(ids.map(async (fid) => {
          try { for (const k of tenantKeys(user, "foto-" + fid)) { const fx = await store.get(k, { type: "json" }); if (fx) return fx; } return null; }
          catch (e) { return null; }
        }));
        return new Response(JSON.stringify(fotos.filter(Boolean)), { status: 200, headers });
      }
      if (id) {
        let foto = null; for (const k of tenantKeys(user, "foto-" + id)) { try { foto = await store.get(k, { type: "json" }); if (foto) break; } catch(e){} }
        return new Response(JSON.stringify(foto || null), { status: 200, headers });
      }
      return new Response("[]", { status: 200, headers });
    } catch (e) {
      return new Response("null", { status: 200, headers });
    }
  }

  if (req.method === "DELETE") {
    try {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (id) await deleteTenantKey(store, user, "foto-" + id);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/foto" };
