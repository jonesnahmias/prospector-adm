import { requireAuth, corsHeaders } from "./_auth.js";

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
  const fimObj = limpo.lastIndexOf("}");
  const iniArr = limpo.indexOf("[");
  const fimArr = limpo.lastIndexOf("]");
  if (ini >= 0 && fimObj > ini) return JSON.parse(limpo.slice(ini, fimObj + 1));
  if (iniArr >= 0 && fimArr > iniArr) return JSON.parse(limpo.slice(iniArr, fimArr + 1));
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

async function chamarBuscaFornecedores(apiKey, prompt, timeoutMs, maxTokens, signal) {
  const model = env("OPENAI_SEARCH_MODEL") || "gpt-5-search-api";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Responda somente JSON valido, sem markdown, sem texto antes ou depois."
        },
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
  return new Response(JSON.stringify({ ok: true, model, modulo: "forn", json }), { status: 200 });
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
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY ainda não está configurada na Netlify." }), { status: 503, headers });
  }

  let modulo = "geral";
  try {
    const body = await req.json();
    modulo = String(body && body.modulo || "geral").slice(0, 80);
    const promptBase = String(body && body.prompt || "").trim();
    if (promptBase.length < 40) {
      return new Response(JSON.stringify({ error: "Prompt muito curto para análise." }), { status: 400, headers });
    }
    const prompt = [
      "OBRIGATÓRIO: responda somente JSON válido, sem explicação, sem markdown e sem texto antes ou depois.",
      "Não use blocos ```json. Não inclua comentários. A primeira letra da resposta deve ser { e a última deve ser }.",
      "",
      promptBase
    ].join("\n");

    const model = modulo === "forn" ? (env("OPENAI_FAST_MODEL") || "gpt-4.1-mini") : (env("OPENAI_MODEL") || "gpt-5-mini");
    const controller = new AbortController();
    const defaultTimeout = modulo === "forn" ? 23000 : ((modulo.includes("orc")) ? 40000 : ((modulo === "plan" || modulo === "dim") ? 38000 : 32000));
    const timeoutMs = Math.min(Math.max(Number(body && body.timeout_ms) || defaultTimeout, 6000), 45000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (modulo === "forn") {
      const maxTokens = Math.min(Number(body && body.max_output_tokens) || 2600, 3600);
      const response = await chamarBuscaFornecedores(apiKey, prompt, timeoutMs, maxTokens, controller.signal);
      clearTimeout(timer);
      const txt = await response.text();
      return new Response(txt, { status: response.status, headers });
    }
    const openaiPayload = {
      model,
      input: prompt,
      max_output_tokens: Math.min(Number(body && body.max_output_tokens) || 3000, 5200),
      store: false,
      text: { format: { type: "json_object" } }
    };
    if (modulo === "forn") {
      openaiPayload.tools = [{
        type: "web_search",
        search_context_size: "medium",
        user_location: {
          type: "approximate",
          country: "BR"
        }
      }];
      openaiPayload.tool_choice = "required";
      openaiPayload.include = ["web_search_call.action.sources"];
    }
    if (model.startsWith("gpt-5")) {
      openaiPayload.reasoning = { effort: "low" };
      openaiPayload.text.verbosity = "medium";
    }
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(openaiPayload),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));

    const data = await openaiResp.json().catch(() => ({}));
    if (!openaiResp.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : "Falha ao chamar a OpenAI.";
      return new Response(JSON.stringify({ error: msg, modulo }), { status: openaiResp.status, headers });
    }
    if (data && data.status === "incomplete") {
      const msg = modulo === "forn"
        ? "A IA gerou uma lista incompleta de fornecedores. Tente novamente ou selecione menos categorias."
        : "A IA gerou uma resposta incompleta. Tente novamente.";
      return new Response(JSON.stringify({ error: msg, modulo }), { status: 502, headers });
    }

    const raw = outputText(data);
    const json = extrairJson(raw);
    return new Response(JSON.stringify({ ok: true, model, modulo, json }), { status: 200, headers });
  } catch (e) {
    if (modulo === "forn" && e instanceof SyntaxError) {
      return new Response(JSON.stringify({
        error: "A IA retornou uma lista de fornecedores incompleta. Tente novamente; se persistir, deixe menos categorias marcadas."
      }), { status: 502, headers });
    }
    if (e && e.name === "AbortError") {
      const msg = modulo === "forn"
        ? "A busca de fornecedores nao conseguiu concluir nesta tentativa. Tente novamente com menos categorias ou informe uma especialidade no complemento."
        : "A análise demorou demais. Tente novamente; se persistir, use uma análise mais enxuta ou reduza o texto/contexto do arquivo.";
      return new Response(JSON.stringify({ error: msg }), { status: 504, headers });
    }
    return new Response(JSON.stringify({ error: e.message || "Erro ao executar análise IA." }), { status: 500, headers });
  }
};

export const config = { path: "/api/ia-json" };
