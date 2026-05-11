import { requireAuth, corsHeaders } from "./_auth.js";

const ORCC_BASE = (process.env.ORCC_BASE_URL || "https://orcc-sc.netlify.app").replace(/\/+$/, "");

function norm(v) {
  let s = String(v || "").toLowerCase();
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
  return s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v || "").replace(/[^\d,.\-]/g, "");
  if (!s) return 0;
  const n = s.includes(",") && s.includes(".")
    ? Number(s.replace(/\./g, "").replace(",", "."))
    : Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function brl(v) {
  const n = num(v);
  return n ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "";
}

async function orccJson(path) {
  const r = await fetch(`${ORCC_BASE}${path}`, { headers: { accept: "application/json" } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.mensagem || data.error || `Falha ao consultar ORCC (${r.status}).`);
  return data;
}

function termosBusca(q) {
  const base = norm(q).split(" ").filter(t => t.length >= 2);
  const extras = [];
  const nq = norm(q);
  if (/cm\s*30|imprima/.test(nq)) extras.push("cm30", "cm 30", "asfalto diluido", "imprimacao", "imprimacao");
  if (/rr\s*1c|rr\s*2c|pintura\s+de\s+liga|ligacao/.test(nq)) extras.push("rr 1c", "rr 2c", "emulsao", "pintura ligacao");
  if (/cbuq|asfalto|cap/.test(nq)) extras.push("asfalto", "cbuq", "cap");
  return Array.from(new Set(base.concat(extras.map(norm).filter(Boolean))));
}

function scoreBiblioteca(lib, qNorm) {
  const txt = norm([lib.name, lib.source, lib.uf, lib.baseDate, lib.type, lib.mode].join(" "));
  let s = 0;
  if (txt.includes("sinapi")) s += 8;
  if (txt.includes("sicro")) s += 7;
  if (txt.includes("orse")) s += 5;
  if (txt.includes("seinfra")) s += 4;
  if (/asfalto|cbuq|cm\s*30|imprima|pavimenta/.test(qNorm) && /asfalto|pavimenta|sicro|sinapi|orse/.test(txt)) s += 25;
  for (const t of qNorm.split(" ").filter(Boolean)) if (txt.includes(t)) s += 2;
  s += Math.min(6, Number(lib.supplyCount || 0) / 1000);
  s += Math.min(6, Number(lib.compositionCount || 0) / 1000);
  return s;
}

function scoreItem(item, termos, qNorm) {
  const txt = norm([item.code, item.description, item.unit, item.category, item.source, item.uf, item.baseDate].join(" "));
  let s = 0;
  if (!txt) return 0;
  for (const t of termos) {
    if (!t) continue;
    if (txt === t) s += 80;
    else if (txt.includes(t)) s += Math.min(35, 8 + t.length);
  }
  const code = norm(item.code);
  if (code && qNorm.includes(code)) s += 60;
  if (/cm\s*30|imprima/.test(qNorm) && /cm\s*30|cm30|asfalto diluido|imprima/.test(txt)) s += 80;
  if (/rr\s*1c|rr\s*2c|pintura\s+de\s+liga|ligacao/.test(qNorm) && /rr\s*1c|rr\s*2c|emulsao|pintura.*liga/.test(txt)) s += 70;
  if (/cbuq/.test(qNorm) && /cbuq|concreto betuminoso|asfalto/.test(txt)) s += 50;
  if (/preco|preço|custo|valor/.test(qNorm)) s += 3;
  return s;
}

function mapItem(item, tipo, lib) {
  const preco = tipo === "composicao" ? num(item.cost) : num(item.price);
  return {
    tipo,
    codigo: item.code || "",
    descricao: item.description || "",
    unidade: item.unit || "",
    preco,
    preco_fmt: brl(preco),
    categoria: item.category || "",
    fonte: item.source || lib.source || "",
    uf: item.uf || lib.uf || "",
    mes: item.baseDate || lib.baseDate || "",
    biblioteca: lib.name || "",
    biblioteca_id: lib.id || "",
    observacao: item.note || ""
  };
}

export default async (req) => {
  const headers = corsHeaders("GET, OPTIONS");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, "admin");
  if (gate.error) return gate.error;
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") || "search";
    const lista = await orccJson("/.netlify/functions/bases-store?action=list");
    const libraries = Array.isArray(lista.libraries) ? lista.libraries : [];
    if (mode === "libraries") {
      return new Response(JSON.stringify({ ok: true, libraries }), { status: 200, headers });
    }

    const q = String(url.searchParams.get("q") || "").trim();
    if (q.length < 2) return new Response(JSON.stringify({ ok: true, results: [], libraries }), { status: 200, headers });
    const qNorm = norm(q);
    const termos = termosBusca(q);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 60);
    const libraryId = url.searchParams.get("libraryId") || "";
    const fonte = norm(url.searchParams.get("fonte") || "");
    const uf = norm(url.searchParams.get("uf") || "");

    let libs = libraries.slice();
    if (libraryId) libs = libs.filter(l => String(l.id) === libraryId);
    if (fonte) libs = libs.filter(l => norm(l.source).includes(fonte) || norm(l.name).includes(fonte));
    if (uf) libs = libs.filter(l => norm(l.uf).includes(uf));
    libs = libs
      .map(l => ({ ...l, _score: scoreBiblioteca(l, qNorm) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, libraryId ? 1 : 8);

    const results = [];
    const erros = [];
    for (const lib of libs) {
      try {
        const data = await orccJson("/.netlify/functions/bases-store?action=load&id=" + encodeURIComponent(lib.id));
        const base = data.base || {};
        const supplies = Array.isArray(base.supplies) ? base.supplies : [];
        const comps = Array.isArray(base.compositions) ? base.compositions : [];
        for (const s of supplies) {
          const sc = scoreItem(s, termos, qNorm);
          if (sc > 0) results.push({ ...mapItem(s, "insumo", lib), score: sc });
        }
        for (const c of comps) {
          const sc = scoreItem(c, termos, qNorm);
          if (sc > 0) results.push({ ...mapItem(c, "composicao", lib), score: sc });
        }
      } catch (e) {
        erros.push(`${lib.name || lib.id}: ${e.message || e}`);
      }
    }

    results.sort((a, b) => b.score - a.score || b.preco - a.preco);
    return new Response(JSON.stringify({
      ok: true,
      query: q,
      libraries: libs.map(({ _score, ...l }) => l),
      results: results.slice(0, limit),
      total_encontrado: results.length,
      erros
    }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "Erro ao sincronizar ORCC." }), { status: 500, headers });
  }
};

export const config = { path: "/api/orcc-precos" };
