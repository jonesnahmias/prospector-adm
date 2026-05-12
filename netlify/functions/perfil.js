import { getStore } from "@netlify/blobs";
import { requireAuth, corsHeaders, getTenantJson, setTenantJson } from './_auth.js';

export default async (req) => {
  const store = getStore({ name: "perfil", consistency: "strong" });
  const headers = corsHeaders("GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, req.method === "GET" ? 'campo' : 'admin');
  if (gate.error) return gate.error;
  const user = gate.user;
  if (req.method === "GET") {
    try {
      const data = await getTenantJson(store, user, "empresa", null);
      return new Response(JSON.stringify(data || null), { status: 200, headers });
    } catch (e) {
      return new Response("null", { status: 200, headers });
    }
  }

  if (req.method === "POST") {
    try {
      const perfil = await req.json();
      await setTenantJson(store, user, "empresa", perfil);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/perfil" };
