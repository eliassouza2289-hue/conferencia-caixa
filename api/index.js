function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function config() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) throw new Error("Supabase não configurado na Vercel");
  return { url, key };
}

async function pg(method, table, params = {}, data, prefer) {
  const { url, key } = config();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const response = await fetch(`${url}/rest/v1/${table}${qs.size ? `?${qs}` : ""}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function normalizeRow(d) {
  return {
    ...d,
    checklist: d.checklist || [],
    perguntas: d.perguntas || {},
    gates: d.gates || {},
    tele: d.tele || {},
  };
}

function caixaVariants(caixa) {
  const raw = String(caixa || "").trim();
  const vals = [];
  if (raw) vals.push(raw);
  const digits = raw.replace(/\D/g, "");
  if (digits) {
    const n = String(Number(digits));
    vals.push(n, digits, `Caixa ${n}`, `Caixa ${digits}`, `Caixa ${String(Number(digits)).padStart(2, "0")}`);
  }
  return [...new Set(vals.filter(Boolean))];
}

async function options() {
  const pessoas = await pg("GET", "pessoas", {
    select: "id,nome,tipo",
    ativo: "eq.true",
    order: "nome.asc",
  });
  return { pessoas: pessoas || [], caixas: [] };
}

async function savePessoa(data) {
  try {
    await pg("POST", "pessoas", {}, { nome: data.nome, tipo: data.tipo, ativo: true }, "return=minimal");
  } catch (err) {
    const msg = String(err.message || err).toLowerCase();
    if (!msg.includes("duplicate") && !msg.includes("23505")) throw err;
    await pg("PATCH", "pessoas", { nome: `eq.${data.nome}`, tipo: `eq.${data.tipo}` }, { ativo: true }, "return=minimal");
  }
}

async function saveMovimentos(confId, caixa, tele = {}) {
  await pg("DELETE", "tele_movimentos", { conferencia_id: `eq.${confId}` });
  const inserts = [];
  for (const m of tele.movimentos || []) {
    const qtd = Number(m.qtd || 0);
    if (qtd <= 0) continue;
    if (m.tipo === "enviada" && String(m.caixa || "").trim()) {
      inserts.push({ conferencia_id: confId, origem: caixa, destino: String(m.caixa).trim(), qtd, obs: m.obs || "", resolvido: false });
    } else if (m.tipo === "recebida") {
      inserts.push({ conferencia_id: confId, origem: m.caixa || "", destino: caixa, qtd, obs: m.obs || "", resolvido: true });
    }
  }
  if (inserts.length) await pg("POST", "tele_movimentos", {}, inserts, "return=minimal");
  await pg("PATCH", "tele_movimentos", { destino: `eq.${caixa}`, conferencia_id: `neq.${confId}` }, { resolvido: true }, "return=minimal");
}

async function avisos(caixa) {
  const vals = caixaVariants(caixa);
  if (!vals.length) return [];
  const params = {
    select: "id,conferencia_id,origem,destino,qtd,obs",
    resolvido: "eq.false",
    order: "criado_em.desc",
  };
  if (vals.length === 1) params.destino = `eq.${vals[0]}`;
  else params.or = `(${vals.map((v) => `destino.eq.${v}`).join(",")})`;
  return (await pg("GET", "tele_movimentos", params)) || [];
}

async function listConferencias(query) {
  const params = { select: "*", order: "data.desc,criado_em.desc" };
  const dataExata = query.get("data");
  const dataInicio = query.get("data_inicio");
  const dataFim = query.get("data_fim");
  if (dataExata) params.data = `eq.${dataExata}`;
  else if (dataInicio && dataFim) params.and = `(data.gte.${dataInicio},data.lte.${dataFim})`;
  else if (dataInicio) params.data = `gte.${dataInicio}`;
  else if (dataFim) params.data = `lte.${dataFim}`;
  if (query.get("numero_caixa")) params.numero_caixa = `ilike.*${query.get("numero_caixa")}*`;
  if (query.get("status")) params.status = `eq.${query.get("status")}`;
  if (query.get("colaborador")) {
    const termo = query.get("colaborador");
    params.or = `(operador.ilike.*${termo}*,responsavel.ilike.*${termo}*)`;
  }
  return ((await pg("GET", "conferencias", params)) || []).map(normalizeRow);
}

async function getConferencia(id) {
  const rows = await pg("GET", "conferencias", { select: "*", id: `eq.${id}`, limit: "1" });
  return rows?.length ? normalizeRow(rows[0]) : null;
}

function confPayload(d) {
  return {
    data: d.data,
    numero_caixa: d.numero_caixa,
    operador: d.operador,
    responsavel: d.responsavel,
    status: d.status,
    checklist: d.checklist || [],
    perguntas: d.perguntas || {},
    gates: d.gates || {},
    tele: d.tele || {},
    observacao_erro: d.observacao_erro || "",
    ajustes: d.ajustes || "",
  };
}

async function createConferencia(data) {
  const rows = await pg("POST", "conferencias", {}, confPayload(data), "return=representation");
  const conf = normalizeRow(rows[0]);
  await saveMovimentos(conf.id, data.numero_caixa, data.tele || {});
  return (await getConferencia(conf.id)) || conf;
}

async function updateConferencia(id, data) {
  await pg("PATCH", "conferencias", { id: `eq.${id}` }, confPayload(data), "return=representation");
  await saveMovimentos(id, data.numero_caixa, data.tele || {});
  return getConferencia(id);
}

async function deleteConferencia(id) {
  await pg("DELETE", "tele_movimentos", { conferencia_id: `eq.${id}` });
  await pg("DELETE", "conferencias", { id: `eq.${id}` });
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/^\/api\/?/, "");

    if (req.method === "GET" && path === "status") {
      const opts = await options();
      return json(res, 200, { banco: "Supabase online", pessoas: opts.pessoas.length });
    }
    if (req.method === "GET" && path === "options") return json(res, 200, await options());
    if (req.method === "GET" && path === "avisos") return json(res, 200, await avisos(url.searchParams.get("caixa")));
    if (req.method === "GET" && path === "conferencias") return json(res, 200, await listConferencias(url.searchParams));
    if (req.method === "POST" && path === "conferencias") return json(res, 201, await createConferencia(await readBody(req)));

    const confMatch = path.match(/^conferencias\/([^/]+)$/);
    if (confMatch) {
      const id = confMatch[1];
      if (req.method === "GET") {
        const item = await getConferencia(id);
        return json(res, item ? 200 : 404, item || {});
      }
      if (req.method === "PUT") return json(res, 200, await updateConferencia(id, await readBody(req)));
      if (req.method === "DELETE") {
        await deleteConferencia(id);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && path === "pessoas") {
      await savePessoa(await readBody(req));
      return json(res, 200, { ok: true });
    }
    const pessoaMatch = path.match(/^pessoas\/([^/]+)$/);
    if (req.method === "DELETE" && pessoaMatch) {
      await pg("PATCH", "pessoas", { id: `eq.${pessoaMatch[1]}` }, { ativo: false }, "return=minimal");
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { erro: "Não encontrado" });
  } catch (err) {
    return json(res, 500, { erro: String(err.message || err) });
  }
};
