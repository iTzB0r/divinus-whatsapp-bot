// Conversas do chat dos sites de clientes (ex.: Anápolis Auto Center).
// O widget do site envia a conversa a cada resposta; o painel do cliente lê daqui.
//   POST /sites/<site>/log              { id, messages:[{role,content}] }  (público, limitado por origem)
//   GET  /sites/<site>/conversas        lista resumida      (Authorization: Bearer <chave do site>)
//   GET  /sites/<site>/conversas/<id>   conversa completa
import { DurableObject } from "cloudflare:workers";

// Site → origens que podem gravar e segredo com a chave do painel.
const SITES = {
  anapolis: {
    origins: ["https://anapolis-auto-center.vercel.app", "https://divinustecnologia.com.br"],
    keyVar: "ANAPOLIS_PAINEL_KEY",
  },
};

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;
const TAG = /<<\s*AGENDA\s*\|([^>]*)>>/i;

const allowedOrigin = (site, origin) =>
  site.origins.includes(origin) || origin.endsWith("-filipe-borjas-projects.vercel.app") || /^http:\/\/localhost:\d+$/.test(origin);

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
  });

export async function handleSites(url, request, env) {
  const [, , siteName, resource, id] = url.pathname.split("/");
  const site = SITES[siteName];
  const origin = request.headers.get("Origin") || "";
  if (!site) return json({ error: "not found" }, 404, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

  const store = env.SITE_CHATS.get(env.SITE_CHATS.idFromName(siteName));

  if (resource === "log" && request.method === "POST") {
    if (!allowedOrigin(site, origin)) return json({ error: "origem não permitida" }, 403, origin);
    let body;
    try { body = await request.json(); } catch { return json({ error: "inválido" }, 400, origin); }
    const convId = typeof body?.id === "string" ? body.id : "";
    const msgs = Array.isArray(body?.messages) ? body.messages : null;
    if (!/^[a-zA-Z0-9-]{8,48}$/.test(convId) || !msgs || !msgs.length || msgs.length > MAX_MESSAGES) {
      return json({ error: "inválido" }, 400, origin);
    }
    const clean = [];
    for (const m of msgs) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return json({ error: "inválido" }, 400, origin);
      clean.push({ role: m.role, content: m.content.slice(0, MAX_CHARS) });
    }
    await store.log(convId, clean, request.headers.get("User-Agent") || "");
    return json({ ok: true }, 200, origin);
  }

  if (resource === "conversas" && request.method === "GET") {
    const key = env[site.keyVar];
    const auth = request.headers.get("Authorization") || "";
    if (!key || auth !== `Bearer ${key}`) return json({ error: "acesso negado" }, 401, origin);
    if (id) {
      const conv = await store.get(id);
      return conv ? json(conv, 200, origin) : json({ error: "não encontrada" }, 404, origin);
    }
    return json({ conversas: await store.list() }, 200, origin);
  }

  return json({ error: "not found" }, 404, origin);
}

export class SiteChats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conversas (
      id TEXT PRIMARY KEY, inicio INTEGER, atualizado INTEGER, total INTEGER,
      ultima TEXT, agendamento TEXT, mensagens TEXT, dispositivo TEXT)`);
  }

  log(id, messages, userAgent) {
    const now = Date.now();
    const last = messages.at(-1);
    let agendamento = null;
    for (const m of messages) {
      const hit = m.role === "assistant" && m.content.match(TAG);
      if (hit) {
        const [servico, carro, preferencia, nome] = hit[1].split("|").map((s) => s.trim());
        agendamento = { servico, carro, preferencia, nome };
      }
    }
    const preview = last.content.replace(TAG, "").trim().slice(0, 160);
    const device = /Mobi|Android|iPhone/i.test(userAgent) ? "celular" : "computador";
    this.ctx.storage.sql.exec(
      `INSERT INTO conversas (id, inicio, atualizado, total, ultima, agendamento, mensagens, dispositivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET atualizado = excluded.atualizado, total = excluded.total,
         ultima = excluded.ultima, agendamento = COALESCE(excluded.agendamento, conversas.agendamento),
         mensagens = excluded.mensagens`,
      id, now, now, messages.length, preview, agendamento && JSON.stringify(agendamento), JSON.stringify(messages), device,
    );
  }

  list() {
    return this.ctx.storage.sql
      .exec("SELECT id, inicio, atualizado, total, ultima, agendamento, dispositivo, mensagens FROM conversas ORDER BY atualizado DESC LIMIT 200")
      .toArray()
      .map((r) => {
        const msgs = JSON.parse(r.mensagens);
        return {
          id: r.id, inicio: r.inicio, atualizado: r.atualizado, total: r.total, ultima: r.ultima,
          dispositivo: r.dispositivo, agendamento: r.agendamento ? JSON.parse(r.agendamento) : null,
          primeira: (msgs.find((m) => m.role === "user")?.content || "").slice(0, 120),
        };
      });
  }

  get(id) {
    const r = this.ctx.storage.sql.exec("SELECT * FROM conversas WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    return { ...r, mensagens: JSON.parse(r.mensagens), agendamento: r.agendamento ? JSON.parse(r.agendamento) : null };
  }
}
