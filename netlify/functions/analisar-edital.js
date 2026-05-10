import { getStore } from "@netlify/blobs";
import { requireAuth, corsHeaders, getTenantJson } from "./_auth.js";

function env(name) {
  try {
    if (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function") {
      return Netlify.env.get(name) || "";
    }
  } catch (e) {}
  try {
    if (typeof process !== "undefined" && process.env) return process.env[name] || "";
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
  throw new Error("A IA retornou uma resposta sem JSON valido.");
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

function anthropicText(resp) {
  const partes = [];
  for (const item of resp && Array.isArray(resp.content) ? resp.content : []) {
    if (typeof item.text === "string") partes.push(item.text);
  }
  return partes.join("\n").trim();
}

function perfilTexto(p) {
  if (!p || typeof p !== "object") return "Perfil nao cadastrado.";
  const campos = [
    ["Razao Social", p.razao],
    ["Nome Fantasia", p.fantasia],
    ["CNPJ", p.cnpj],
    ["Porte", p.porte],
    ["Responsavel", p.responsavel],
    ["CREA", p.crea],
    ["Capital Social", p.capital],
    ["Faturamento Medio Anual", p.fat],
    ["Cidade/UF", [p.cidade, p.uf].filter(Boolean).join("/")],
    ["Atuacao", p.atuacao],
    ["Acervo Tecnico", p.acervo],
    ["Capacidade Tecnica", p.capacidade],
    ["Observacoes", p.obs]
  ];
  return campos
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n") || "Perfil nao cadastrado.";
}

function regrasTecnicasEdital(edital, contexto) {
  const texto = `${edital || ""}\n${contexto || ""}`;
  const pav = /cb[uú]q|asfalto|asf[aá]lt|cap\b|pavimenta|recape|capeamento|rodovia|vi[aá]ria|ponte|acesso|fresagem|tapa[- ]?buraco/i.test(texto);
  return [
    "REGRAS TECNICAS OBRIGATORIAS:",
    "- Identifique a tipologia real da obra pelo objeto, planilhas, memoriais, prazos e exigencias. Nao dependa de uma classificacao generica.",
    "- Converta o edital em servicos executivos, equipamentos provaveis, insumos criticos, controles de qualidade, riscos e documentos exigidos.",
    "- Se um servico estiver implicito no objeto, trate como necessario mesmo que nao esteja escrito em item separado.",
    "- Para pavimentacao, acesso viario, CBUQ, CAP, recapeamento ou asfalto, considerar: mobilizacao, topografia/locacao, limpeza/fresagem se aplicavel, regularizacao do subleito, sub-base/base, imprimacao, pintura de ligacao, fornecimento/transporte/aplicacao de CBUQ, compactacao, sinalizacao, drenagem se houver, ensaios/laboratorio e controle tecnologico.",
    "- Para pavimentacao asfaltica/CBUQ, avaliar obrigatoriamente recursos como vibroacabadora de asfalto, rolo tandem liso, rolo pneumatico, caminhoes basculantes, caminhao espargidor, motoniveladora, pa carregadeira, retro/escavadeira, caminhao pipa, fresadora quando houver recape/fresagem, topografia, laboratorio/ensaios e sinalizacao.",
    "- Se o edital nao permitir concluir algum dado essencial, registre em pontos_atencao ou lacunas_tecnicas, nao omita.",
    pav ? "- TIPO DETECTADO: obra viaria/pavimentacao/asfalto/CBUQ. A analise deve refletir etapas, equipamentos e controles dessa especialidade." : ""
  ].filter(Boolean).join("\n");
}

function promptEdital(perfil, edital, contexto) {
  return [
    "MOTOR DE ANALISE ENGENHARIA v2.",
    "Voce e especialista em licitacoes publicas de obras de construcao civil no Brasil, com foco na Lei 14.133/21.",
    "Analise o edital cruzando as exigencias com o perfil cadastrado da empresa.",
    regrasTecnicasEdital(edital, contexto),
    "OBRIGATORIO: responda somente JSON valido, sem explicacao, sem markdown e sem texto antes ou depois.",
    "Nao use blocos ```json. Nao inclua comentarios. A primeira letra da resposta deve ser { e a ultima deve ser }.",
    "",
    "FORMATO OBRIGATORIO:",
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

async function chamarAnthropicEdital(prompt, signal) {
  const base = (env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, "");
  const apiKey = env("ANTHROPIC_API_KEY");
  const model = env("ANTHROPIC_MODEL") || "claude-sonnet-4-5-20250929";
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01"
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  const resp = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 4600,
      temperature: 0.2,
      system: "Motor Engenharia v2: aja como engenheiro civil senior e responda somente JSON valido.",
      messages: [{ role: "user", content: prompt }]
    }),
    signal
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar Claude/Anthropic.";
    throw new Error(msg);
  }
  return { raw: anthropicText(data), model, provider: "anthropic" };
}

async function chamarOpenAIEdital(prompt, signal) {
  const apiKey = env("OPENAI_API_KEY");
  const base = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env("OPENAI_MODEL") || "gpt-5-mini";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = {
    model,
    input: prompt,
    max_output_tokens: 4500,
    store: false,
    text: { format: { type: "json_object" } }
  };
  if (model.startsWith("gpt-5")) {
    payload.reasoning = { effort: "low" };
    payload.text.verbosity = "medium";
  }
  const resp = await fetch(`${base}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar a OpenAI.";
    throw new Error(msg);
  }
  return { raw: outputText(data), model, provider: "openai" };
}

export default async (req) => {
  const headers = corsHeaders("POST, OPTIONS");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, "admin");
  if (gate.error) return gate.error;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  try {
    const body = await req.json();
    const edital = String(body && body.edital || "").trim();
    const contexto = String(body && body.contexto || "").trim();
    if (edital.length < 100) {
      return new Response(JSON.stringify({ error: "Texto do edital muito curto para analise." }), { status: 400, headers });
    }

    const openaiReady = !!(env("OPENAI_API_KEY") || env("OPENAI_BASE_URL"));
    const anthropicReady = !!(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_BASE_URL"));
    if (!openaiReady && !anthropicReady) {
      return new Response(JSON.stringify({ error: "Configure OPENAI_API_KEY/OPENAI_BASE_URL ou ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL na Netlify para usar o Motor Engenharia v2." }), { status: 503, headers });
    }

    const perfilStore = getStore({ name: "perfil", consistency: "strong" });
    const perfil = await getTenantJson(perfilStore, gate.user, "empresa", null);
    const prompt = promptEdital(perfil, edital, contexto);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 38000);
    const preferencia = String(body && body.provider || env("AI_PROVIDER") || "auto").toLowerCase();
    const providers = [];
    if ((preferencia === "anthropic" || preferencia === "claude") && anthropicReady) providers.push("anthropic");
    if (preferencia === "openai" && openaiReady) providers.push("openai");
    if (!providers.length) {
      if (anthropicReady) providers.push("anthropic");
      if (openaiReady) providers.push("openai");
    }
    if (!providers.includes("openai") && openaiReady) providers.push("openai");
    if (!providers.includes("anthropic") && anthropicReady && preferencia !== "openai") providers.push("anthropic");

    const erros = [];
    let resultado = null;
    for (const provider of providers) {
      try {
        resultado = provider === "anthropic"
          ? await chamarAnthropicEdital(prompt, controller.signal)
          : await chamarOpenAIEdital(prompt, controller.signal);
        break;
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        erros.push(`${provider}: ${err && err.message ? err.message : "falha"}`);
      }
    }
    clearTimeout(timer);
    if (!resultado) {
      return new Response(JSON.stringify({ error: "O Motor Engenharia v2 nao conseguiu analisar o edital. " + erros.join(" | ") }), { status: 502, headers });
    }

    const analise = extrairJson(resultado.raw);
    analise._motor_v2 = {
      versao: "engenharia-v2",
      provider: resultado.provider,
      model: resultado.model
    };
    return new Response(JSON.stringify({ ok: true, provider: resultado.provider, model: resultado.model, analise }), { status: 200, headers });
  } catch (e) {
    if (e && e.name === "AbortError") {
      return new Response(JSON.stringify({ error: "A analise demorou demais. Tente novamente ou reduza o texto do edital para as paginas principais." }), { status: 504, headers });
    }
    return new Response(JSON.stringify({ error: e.message || "Erro ao analisar edital." }), { status: 500, headers });
  }
};

export const config = { path: "/api/analisar-edital" };
