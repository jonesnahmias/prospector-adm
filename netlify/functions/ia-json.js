import { requireAuth, corsHeaders } from "./_auth.js";

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
  const iniObj = limpo.indexOf("{");
  const fimObj = limpo.lastIndexOf("}");
  const iniArr = limpo.indexOf("[");
  const fimArr = limpo.lastIndexOf("]");
  if (iniObj >= 0 && fimObj > iniObj) return JSON.parse(limpo.slice(iniObj, fimObj + 1));
  if (iniArr >= 0 && fimArr > iniArr) return JSON.parse(limpo.slice(iniArr, fimArr + 1));
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

function motorEngenhariaPrompt(modulo, truth) {
  const isOrc = String(modulo || "").includes("orc");
  const base = [
    "MOTOR DE ANALISE ENGENHARIA v2.",
    "Voce atua como engenheiro civil senior, orcamentista e planejador de obras no Brasil.",
    "A resposta deve ter profundidade tecnica, sem texto generico.",
    "Nunca calcule totais de planilha por estimativa: use os dados confiaveis fornecidos como fonte de verdade.",
    "Quando houver divergencia entre IA e dado extraido do arquivo, prevalece o dado extraido do arquivo.",
    "Avalie escopo, metodologia executiva, riscos, recursos, equipamentos, materiais, controles de qualidade, restricoes e lacunas.",
    "Para pavimentacao/asfalto/CBUQ/CAP, verificar obrigatoriamente: regularizacao/sub-base/base, imprimacao, pintura de ligacao, CBUQ, transporte, vibroacabadora, rolo tandem, rolo pneumatico, caminhoes basculantes, espargidor, motoniveladora, pa carregadeira, caminhao pipa, sinalizacao, topografia, laboratorio/ensaios e controle tecnologico.",
    "Retorne somente JSON valido, sem markdown, sem texto antes ou depois."
  ];
  if (isOrc) {
    base.push("Para orcamento, a analise deve conter total_geral, total_itens, BDI, tipo_obra, grupos, top_itens, alertas, lacunas_tecnicas e recomendacoes.");
    base.push("Se a planilha trouxer grupos/etapas, use-os para montar top_itens e grupos por relevancia financeira.");
  }
  if (truth && Object.keys(truth).length) {
    base.push("DADOS CONFIAVEIS EXTRAIDOS PELO APP:");
    base.push(JSON.stringify(truth).slice(0, 12000));
  }
  return base.join("\n");
}

function textoContemPavimentacao(texto) {
  return /cb[uú]q|asfalto|asf[aá]lt|cap\b|pavimenta|imprima|pintura de liga|recape|capeamento|rodovia|vi[aá]ria/i.test(String(texto || ""));
}

function numFromText(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v || "").replace(/[^\d,.\-]/g, "");
  if (!s) return NaN;
  const n = s.includes(",") && s.includes(".")
    ? Number(s.replace(/\./g, "").replace(",", "."))
    : Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function fmtBRL(n) {
  n = Number(n || 0);
  if (!Number.isFinite(n) || !n) return "";
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function auditEngineeringJson(json, modulo, truth, prompt, meta = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const out = { ...json };
  out.resumo = out.resumo && typeof out.resumo === "object" ? { ...out.resumo } : {};
  out.alertas = Array.isArray(out.alertas) ? out.alertas.slice() : [];
  out.recomendacoes = Array.isArray(out.recomendacoes) ? out.recomendacoes.slice() : [];
  const tOrc = truth && truth.orcamento ? truth.orcamento : null;
  if (tOrc) {
    const totalTruth = Number(tOrc.total_geral_num || 0);
    const totalIa = numFromText(out.resumo.total_geral || out.total_geral || out.total || "");
    if (tOrc.total_geral) out.resumo.total_geral = tOrc.total_geral;
    if (tOrc.bdi && !out.resumo.bdi_identificado) out.resumo.bdi_identificado = tOrc.bdi;
    if (tOrc.total_itens && !out.resumo.total_itens) out.resumo.total_itens = tOrc.total_itens;
    if (totalTruth && totalIa && Math.abs(totalIa - totalTruth) > Math.max(10, totalTruth * 0.01)) {
      out.alertas.push({
        tipo: "DIVERGENCIA_TOTAL_CORRIGIDA",
        item: "Total geral",
        detalhe: `A IA retornou ${fmtBRL(totalIa)}, mas a planilha indica ${tOrc.total_geral}. O app corrigiu para o valor da planilha.`
      });
    }
    if ((!Array.isArray(out.grupos) || !out.grupos.length) && Array.isArray(tOrc.top_grupos)) {
      out.grupos = tOrc.top_grupos.slice(0, 12).map(g => ({
        nome: `${g.item ? g.item + " - " : ""}${g.descricao || ""}`,
        valor: g.total_fmt || fmtBRL(g.total),
        percentual: totalTruth && g.total ? `${((Number(g.total) / totalTruth) * 100).toFixed(1).replace(".", ",")}%` : ""
      }));
    }
    if ((!Array.isArray(out.top_itens) || !out.top_itens.length) && Array.isArray(tOrc.top_grupos)) {
      out.top_itens = tOrc.top_grupos.slice(0, 10).map(g => ({
        descricao: `${g.item ? g.item + " - " : ""}${g.descricao || ""}`,
        valor_total: g.total_fmt || fmtBRL(g.total),
        percentual_orcamento: totalTruth && g.total ? `${((Number(g.total) / totalTruth) * 100).toFixed(1).replace(".", ",")}%` : "",
        status: "OK",
        obs: "Extraido diretamente da planilha."
      }));
    }
  }
  const textoJson = JSON.stringify(out);
  const pav = textoContemPavimentacao(prompt) || textoContemPavimentacao(textoJson);
  if (pav) {
    const precisa = ["vibroacabadora", "rolo", "basculante", "espargidor", "imprima", "pintura de liga", "ensai"];
    const faltando = precisa.filter(k => !new RegExp(k, "i").test(textoJson));
    if (faltando.length) {
      out.alertas.push({
        tipo: "LACUNA_TECNICA",
        item: "Pavimentacao / CBUQ / CAP",
        detalhe: "A analise deve conferir explicitamente equipamentos, transporte, espalhamento, compactacao, imprimacao, pintura de ligacao, ensaios e controle tecnologico."
      });
      out.recomendacoes.push("Revisar metodologia executiva de pavimentacao/CBUQ/CAP com foco em vibroacabadora, rolos, caminhoes, espargidor, compactacao, ensaios e liberacoes.");
    }
  }
  out._motor_v2 = {
    versao: "engenharia-v2",
    provider: meta.provider || "",
    model: meta.model || "",
    auditoria: "dados deterministicos preservados e lacunas tecnicas verificadas"
  };
  return out;
}

async function chamarAnthropic(prompt, system, maxTokens, signal) {
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
      max_tokens: maxTokens,
      temperature: 0.2,
      system,
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

async function chamarOpenAI(apiKey, prompt, system, model, maxTokens, signal) {
  const base = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const openaiPayload = {
    model,
    input: [system, "", prompt].join("\n"),
    max_output_tokens: maxTokens,
    store: false,
    text: { format: { type: "json_object" } }
  };
  if (model.startsWith("gpt-5")) {
    openaiPayload.reasoning = { effort: "low" };
    openaiPayload.text.verbosity = "medium";
  }
  const resp = await fetch(`${base}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(openaiPayload),
    signal
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar a OpenAI.";
    throw new Error(msg);
  }
  if (data && data.status === "incomplete") throw new Error("A IA gerou uma resposta incompleta. Tente novamente.");
  return { raw: outputText(data), model, provider: "openai" };
}

async function chamarBuscaFornecedores(apiKey, prompt, maxTokens, signal) {
  const model = env("OPENAI_SEARCH_MODEL") || "gpt-5-search-api";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Responda somente JSON valido, sem markdown, sem texto antes ou depois." },
        { role: "user", content: prompt }
      ],
      web_search_options: {
        user_location: {
          type: "approximate",
          approximate: {
            country: "BR",
            timezone: "America/Sao_Paulo"
          }
        }
      },
      max_tokens: maxTokens
    }),
    signal
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar a busca web da OpenAI.";
    return new Response(JSON.stringify({ error: msg, modulo: "forn" }), { status: resp.status });
  }
  const raw = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
  const json = extrairJson(raw);
  return new Response(JSON.stringify({ ok: true, model, provider: "openai-search", modulo: "forn", json }), { status: 200 });
}

export default async (req) => {
  const headers = corsHeaders("POST, OPTIONS");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const gate = requireAuth(req, headers, "admin");
  if (gate.error) return gate.error;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  let modulo = "geral";
  try {
    const body = await req.json();
    modulo = String(body && body.modulo || "geral").slice(0, 80);
    const promptBase = String(body && body.prompt || "").trim();
    if (promptBase.length < 40) {
      return new Response(JSON.stringify({ error: "Prompt muito curto para analise." }), { status: 400, headers });
    }
    const prompt = [
      "OBRIGATORIO: responda somente JSON valido, sem explicacao, sem markdown e sem texto antes ou depois.",
      "Nao use blocos ```json. Nao inclua comentarios. A primeira letra da resposta deve ser { e a ultima deve ser }.",
      "",
      promptBase
    ].join("\n");

    const openaiKey = env("OPENAI_API_KEY");
    const openaiReady = !!(openaiKey || env("OPENAI_BASE_URL"));
    const anthropicReady = !!(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_BASE_URL"));
    const controller = new AbortController();
    const defaultTimeout = modulo === "forn" ? 23000 : ((modulo.includes("orc")) ? 40000 : ((modulo === "plan" || modulo === "dim") ? 38000 : 32000));
    const timeoutMs = Math.min(Math.max(Number(body && body.timeout_ms) || defaultTimeout, 6000), 45000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (modulo === "forn") {
      if (!openaiKey) {
        clearTimeout(timer);
        return new Response(JSON.stringify({ error: "OPENAI_API_KEY e necessaria para busca web de fornecedores." }), { status: 503, headers });
      }
      const maxTokens = Math.min(Number(body && body.max_output_tokens) || 2600, 3600);
      const response = await chamarBuscaFornecedores(openaiKey, prompt, maxTokens, controller.signal);
      clearTimeout(timer);
      const txt = await response.text();
      return new Response(txt, { status: response.status, headers });
    }

    if (!openaiReady && !anthropicReady) {
      clearTimeout(timer);
      return new Response(JSON.stringify({ error: "Configure OPENAI_API_KEY/OPENAI_BASE_URL ou ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL na Netlify para usar o Motor Engenharia v2." }), { status: 503, headers });
    }

    const truth = body && body.truth && typeof body.truth === "object" ? body.truth : {};
    const system = motorEngenhariaPrompt(modulo, truth);
    const maxTokens = Math.min(Number(body && body.max_output_tokens) || 3400, 6200);
    const preferencia = String(body && body.provider || env("AI_PROVIDER") || "auto").toLowerCase();
    const providers = [];
    if ((preferencia === "anthropic" || preferencia === "claude") && anthropicReady) providers.push("anthropic");
    if (preferencia === "openai" && openaiReady) providers.push("openai");
    if (!providers.length) {
      if (openaiReady) providers.push("openai");
      if (anthropicReady) providers.push("anthropic");
    }
    if (!providers.includes("openai") && openaiReady) providers.push("openai");
    if (!providers.includes("anthropic") && anthropicReady && preferencia !== "openai") providers.push("anthropic");

    const erros = [];
    let resultado = null;
    for (const provider of providers) {
      try {
        if (provider === "anthropic") {
          resultado = await chamarAnthropic(prompt, system, maxTokens, controller.signal);
        } else {
          const model = env("OPENAI_MODEL") || "gpt-5-mini";
          resultado = await chamarOpenAI(openaiKey, prompt, system, model, maxTokens, controller.signal);
        }
        break;
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        erros.push(`${provider}: ${err && err.message ? err.message : "falha"}`);
      }
    }
    clearTimeout(timer);
    if (!resultado) {
      return new Response(JSON.stringify({ error: "O Motor Engenharia v2 nao conseguiu concluir com os provedores configurados. " + erros.join(" | "), modulo }), { status: 502, headers });
    }

    const json = auditEngineeringJson(extrairJson(resultado.raw), modulo, truth, prompt + "\n" + system, resultado);
    return new Response(JSON.stringify({ ok: true, provider: resultado.provider, model: resultado.model, modulo, json }), { status: 200, headers });
  } catch (e) {
    if (modulo === "forn" && e instanceof SyntaxError) {
      return new Response(JSON.stringify({
        error: "A IA retornou uma lista de fornecedores incompleta. Tente novamente; se persistir, deixe menos categorias marcadas."
      }), { status: 502, headers });
    }
    if (e && e.name === "AbortError") {
      const msg = modulo === "forn"
        ? "A busca de fornecedores nao conseguiu concluir nesta tentativa. Tente novamente com menos categorias ou informe uma especialidade no complemento."
        : "A analise demorou demais. Tente novamente; se persistir, use uma analise mais enxuta ou reduza o texto/contexto do arquivo.";
      return new Response(JSON.stringify({ error: msg }), { status: 504, headers });
    }
    return new Response(JSON.stringify({ error: e.message || "Erro ao executar analise IA." }), { status: 500, headers });
  }
};

export const config = { path: "/api/ia-json" };
