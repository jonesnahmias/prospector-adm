import { getStore } from "@netlify/blobs";
import { requireAuth, corsHeaders, getTenantJson } from "./_auth.js";

function env(name) {
  try {
    if (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function") {
      return Netlify.env.get(name) || "";
    }
  } catch (e) {}
  return "";
}

function limparTextoJson(txt) {
  return String(txt || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extrairJson(txt) {
  const limpo = limparTextoJson(txt);
  try { return JSON.parse(limpo); } catch (e) {}
  const ini = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (ini >= 0 && fim > ini) return JSON.parse(limpo.slice(ini, fim + 1));
  throw new Error("A IA retornou uma resposta sem JSON válido.");
}

function outputText(resp) {
  if (resp && typeof resp.output_text === "string") return resp.output_text;
  const partes = [];
  for (const item of resp && Array.isArray(resp.output) ? resp.output : []) {
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (typeof c.text === "string") partes.push(c.text);
      if (typeof c.output_text === "string") partes.push(c.output_text);
    }
  }
  return partes.join("\n").trim();
}

function perfilTexto(p) {
  if (!p || typeof p !== "object") return "Perfil não cadastrado.";
  const campos = [
    ["Razão Social", p.razao],
    ["Nome Fantasia", p.fantasia],
    ["CNPJ", p.cnpj],
    ["Porte", p.porte],
    ["Responsável", p.responsavel],
    ["CREA", p.crea],
    ["Capital Social", p.capital],
    ["Faturamento Médio Anual", p.fat],
    ["Cidade/UF", [p.cidade, p.uf].filter(Boolean).join("/")],
    ["Atuação", p.atuacao],
    ["Acervo Técnico", p.acervo],
    ["Capacidade Técnica", p.capacidade],
    ["Observações", p.obs]
  ];
  return campos
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n") || "Perfil não cadastrado.";
}

function regrasTecnicasEdital(edital, contexto) {
  const texto = `${edital || ""}\n${contexto || ""}`;
  const pav = /cb[uú]q|asfalto|asf[aá]lt|cap\b|pavimenta|recape|capeamento|rodovia|vi[aá]ria|ponte|acesso|fresagem|tapa[- ]?buraco/i.test(texto);
  return [
    "REGRAS TECNICAS OBRIGATORIAS:",
    "- Identifique a tipologia real da obra pelo objeto, planilhas, memoriais, prazos e exigencias. Nao dependa de uma classificacao generica.",
    "- Converta o edital em servicos executivos, equipamentos provaveis, insumos criticos, controles de qualidade, riscos e documentos exigidos.",
    "- Se um servico estiver implicito no objeto, trate como necessario mesmo que nao esteja escrito em item separado.",
    "- Para pavimentacao, acesso viario, CBUQ, CAP, recapeamento ou asfalto, considerar: mobilizacao, topografia/locacao, limpeza/fresagem se aplicavel, regularizacao do subleito, sub-base/base, imprimação, pintura de ligacao, fornecimento/transporte/aplicacao de CBUQ, compactacao, sinalizacao, drenagem se houver, ensaios/laboratorio e controle tecnologico.",
    "- Para pavimentacao asfaltica/CBUQ, avaliar obrigatoriamente recursos como vibroacabadora de asfalto, rolo tandem liso, rolo pneumatico, caminhoes basculantes, caminhao espargidor, motoniveladora, pa carregadeira, retro/escavadeira, caminhao pipa, fresadora quando houver recape/fresagem, topografia, laboratorio/ensaios e sinalizacao.",
    "- Se o edital nao permitir concluir algum dado essencial, registre em pontos_atencao ou lacunas_tecnicas, nao omita.",
    pav ? "- TIPO DETECTADO: obra viaria/pavimentacao/asfalto/CBUQ. A analise deve refletir etapas, equipamentos e controles dessa especialidade." : ""
  ].filter(Boolean).join("\n");
}

function promptEdital(perfil, edital, contexto) {
  return [
    "Você é especialista em licitações públicas de obras de construção civil no Brasil, com foco na Lei 14.133/21.",
    "Analise o edital cruzando as exigências com o perfil cadastrado da empresa.",
    regrasTecnicasEdital(edital, contexto),
    "OBRIGATÓRIO: responda somente JSON válido, sem explicação, sem markdown e sem texto antes ou depois.",
    "Não use blocos ```json. Não inclua comentários. A primeira letra da resposta deve ser { e a última deve ser }.",
    "",
    "FORMATO OBRIGATÓRIO:",
    '{"objeto":"","tipo_obra":"","valor_estimado":"","prazo_execucao":"","prazo_proposta":"","modalidade":"","servicos_criticos":[],"equipamentos_criticos":[],"insumos_criticos":[],"controles_qualidade":[],"lacunas_tecnicas":[],"requisitos_tecnicos":[],"pontos_atencao":[],"qualificacao":{"score":0,"hab_juridica":{"status":"APTO/INAPTO/ATENCAO","obs":""},"qual_economica":{"status":"APTO/INAPTO/ATENCAO","obs":""},"qual_tecnica":{"status":"APTO/INAPTO/ATENCAO","obs":""},"reg_fiscal":{"status":"APTO/INAPTO/ATENCAO","obs":""},"cap_operacional":{"status":"APTO/INAPTO/ATENCAO","obs":""},"pendencias":[],"diferenciais":[]},"recomendacao":"PARTICIPAR/AVALIAR/DESCARTAR","justificativa":""}',
    "",
    "PERFIL DA EMPRESA:",
    perfilTexto(perfil),
    "",
    contexto ? "CONTEXTO ADICIONAL DA OBRA:\n" + contexto : "",
    "",
    "EDITAL:",
    String(edital || "").slice(0, 30000)
  ].filter(Boolean).join("\n");
}

export default async (req) => {
  const headers = corsHeaders("POST, OPTIONS");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, "admin");
  if (gate.error) return gate.error;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY ainda não está configurada nas variáveis de ambiente da Netlify." }), { status: 503, headers });
  }

  try {
    const body = await req.json();
    const edital = String(body && body.edital || "").trim();
    const contexto = String(body && body.contexto || "").trim();
    if (edital.length < 100) {
      return new Response(JSON.stringify({ error: "Texto do edital muito curto para análise." }), { status: 400, headers });
    }

    const perfilStore = getStore({ name: "perfil", consistency: "strong" });
    const perfil = await getTenantJson(perfilStore, gate.user, "empresa", null);
    const model = env("OPENAI_MODEL") || "gpt-5-mini";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 38000);
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: promptEdital(perfil, edital, contexto),
        reasoning: { effort: "low" },
        max_output_tokens: 4500,
        store: false,
        text: { verbosity: "medium", format: { type: "json_object" } }
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));

    const data = await openaiResp.json().catch(() => ({}));
    if (!openaiResp.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar a OpenAI.";
      return new Response(JSON.stringify({ error: msg }), { status: openaiResp.status, headers });
    }

    const raw = outputText(data);
    const analise = extrairJson(raw);
    return new Response(JSON.stringify({ ok: true, model, analise }), { status: 200, headers });
  } catch (e) {
    if (e && e.name === "AbortError") {
      return new Response(JSON.stringify({ error: "A análise demorou demais. Tente novamente ou reduza o texto do edital para as páginas principais." }), { status: 504, headers });
    }
    return new Response(JSON.stringify({ error: e.message || "Erro ao analisar edital." }), { status: 500, headers });
  }
};

export const config = { path: "/api/analisar-edital" };
