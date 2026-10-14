// Divinus WhatsApp bot (Cloudflare Worker).
//
// - GET  /webhook  -> verificação do webhook pela Meta
// - POST /webhook  -> mensagens dos clientes (e ecos das mensagens enviadas pelo app)
// - Cada cliente tem um Durable Object "Conversa": guarda o histórico, responde com
//   Claude e agenda os lembretes de recuperação com alarmes.
//
// Segredos (wrangler secret put): ANTHROPIC_API_KEY, WA_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN
// Variáveis (wrangler.toml): WA_PHONE_NUMBER_ID, GRAPH_VERSION, TEAM_EMAIL, FROM_EMAIL
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { Painel, painel, handlePainel, authorized } from "./painel.js";
import { Demos, handleDemo, DEMO_HOST } from "./demo.js";
import { SYSTEM, TOOLS, NUDGE_15MIN, NUDGE_22H, OPT_OUT_REPLY, MEDIA_REPLY } from "./prompt.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_HISTORY = 40;          // mensagens guardadas por conversa
const DEBOUNCE_MS = 4000;        // espera mensagens em sequência antes de responder
const HUMAN_PAUSE = 12 * HOUR;   // bot fica quieto depois que alguém da equipe responde pelo app
const TZ_OFFSET = -3 * HOUR;     // Belém (UTC-3, sem horário de verão)

// Lembretes: [etapa] -> quando sai (a partir do último contato) e de que tipo é.
const FOLLOWUPS = [
  { after: 15 * MIN, kind: "text", text: NUDGE_15MIN },
  { after: 22 * HOUR, kind: "text", text: NUDGE_22H },
  { after: 3 * DAY, kind: "template", template: "divinus_retorno_3d" },
  { after: 7 * DAY, kind: "template", template: "divinus_retorno_7d" },
];

// ---------------------------------------------------------------- Worker

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === DEMO_HOST || env.DEMO_LOCAL === "1") return handleDemo(url, request, env, authorized);
    if (url.pathname === "/admin") return admin(url, request, env);
    if (url.pathname === "/admin/registrar") return registerPage(url, request, env);
    if (url.pathname === "/painel" || url.pathname.startsWith("/painel/")) return handlePainel(url, request, env, stub);
    if (url.pathname !== "/webhook") return new Response("Divinus WhatsApp bot", { status: 200 });

    if (request.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.WA_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge")) : new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!(await validSignature(raw, request.headers.get("x-hub-signature-256"), env.WA_APP_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload;
    try { payload = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }

    // Responde 200 na hora (a Meta reenvia se demorar) e processa em segundo plano.
    ctx.waitUntil(route(payload, env));
    return new Response("OK");
  },
};

async function route(payload, env) {
  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== env.WA_PHONE_NUMBER_ID) continue;

      // Mensagens dos clientes
      for (const msg of v.messages || []) {
        const name = v.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name || "";
        const text = msg.type === "text" ? msg.text?.body
          : msg.type === "button" ? msg.button?.text
          : msg.type === "interactive" ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title)
          : null;
        jobs.push(stub(env, msg.from).fetch("https://do/inbound", {
          method: "POST",
          body: JSON.stringify({ id: msg.id, from: msg.from, name, text, type: msg.type }),
        }));
      }

      // Ecos (modo coexistência): alguém da equipe respondeu pelo app WhatsApp Business.
      for (const echo of v.message_echoes || []) {
        if (echo.to) jobs.push(stub(env, echo.to).fetch("https://do/human", { method: "POST" }));
      }
    }
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.log("route error", String(r.reason));
}

// Diagnóstico da conexão com a Meta (protegido pelo WA_VERIFY_TOKEN).
// GET  /admin?key=...&waba=ID  -> status do número e apps assinados na conta
// POST /admin?key=...&waba=ID  -> assina este app na conta do WhatsApp (webhooks)
async function admin(url, request, env) {
  if (!env.WA_VERIFY_TOKEN || url.searchParams.get("key") !== env.WA_VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }
  const waba = url.searchParams.get("waba");
  const base = `https://graph.facebook.com/${env.GRAPH_VERSION}`;
  const auth = { Authorization: `Bearer ${env.WA_TOKEN}` };
  const get = async (path) => (await fetch(`${base}/${path}`, { headers: auth })).json();
  const out = {};
  if (request.method === "POST" && url.searchParams.get("profile") === "1") {
    out.profile_update = await (await fetch(`${base}/${env.WA_PHONE_NUMBER_ID}/whatsapp_business_profile`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        about: "Sites, chatbots com IA e painéis de BI. Atendimento 24h.",
        description: "A Divinus cria sites, chatbots com inteligência artificial e painéis de BI sob medida para empresas. Fale com nosso assistente a qualquer hora e agende um diagnóstico gratuito com a equipe.",
        address: "Belém, PA",
        email: "contato@divinustecnologia.com.br",
        websites: ["https://divinustecnologia.com.br/"],
        vertical: "PROF_SERVICES",
      }),
    })).json();
  }
  if (request.method === "POST" && waba && url.searchParams.get("templates") === "1") {
    const make = (name, text, example, buttons) => fetch(`${base}/${waba}/message_templates`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name, language: "pt_BR", category: "MARKETING",
        components: [
          { type: "BODY", text, example: { body_text: [[example]] } },
          { type: "BUTTONS", buttons: buttons.map((t) => ({ type: "QUICK_REPLY", text: t })) },
        ],
      }),
    }).then((r) => r.json());
    out.templates = {
      d3: await make("divinus_retorno_3d",
        "Oi, {{1}}! Aqui é a Divinus 👋 Ficou alguma dúvida sobre site, chatbot ou painel de dados? Nosso diagnóstico gratuito leva só 20 minutos e mostra o que sua empresa pode melhorar. Quer marcar um horário?",
        "Ana", ["Quero marcar", "Agora não"]),
      d7: await make("divinus_retorno_7d",
        "Oi, {{1}}! Última mensagem por aqui, prometo 🙂 Se em algum momento sua empresa precisar de um site, chatbot ou painel de dados, é só responder esta conversa. Até mais! Equipe Divinus",
        "Ana", ["Quero conversar", "Não tenho interesse"]),
    };
    return Response.json(out);
  }
  if (request.method === "POST" && waba) {
    out.subscribe = await (await fetch(`${base}/${waba}/subscribed_apps`, { method: "POST", headers: auth })).json();
  }
  out.profile = await get(`${env.WA_PHONE_NUMBER_ID}/whatsapp_business_profile?fields=about,description,address,email,websites,vertical,profile_picture_url`);
  out.phone = await get(`${env.WA_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,name_status,code_verification_status,status,platform_type,quality_rating`);
  if (waba) out.subscribed_apps = await get(`${waba}/subscribed_apps`);
  return Response.json(out);
}

// Página para o dono registrar o número na Cloud API com o PIN de duas etapas.
// O PIN é digitado pelo próprio dono e vai direto para a Meta; não é guardado.
async function registerPage(url, request, env) {
  const key = url.searchParams.get("key");
  if (!env.WA_VERIFY_TOKEN || key !== env.WA_VERIFY_TOKEN) return new Response("Forbidden", { status: 403 });
  let msg = "";
  if (request.method === "POST") {
    const pin = String((await request.formData()).get("pin") || "");
    if (!/^\d{6}$/.test(pin)) {
      msg = "O PIN precisa ter exatamente 6 números.";
    } else {
      const res = await fetch(`https://graph.facebook.com/${env.GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
      const out = await res.json();
      msg = res.ok && out.success ? "✅ Número registrado! O bot já está atendendo." : `❌ A Meta recusou: ${out.error?.message || res.status}`;
    }
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registrar número</title>
<style>body{font-family:system-ui,sans-serif;background:#0A1737;color:#FCF3E3;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}form{background:#0E1D45;border:1px solid #DDBD8455;border-radius:16px;padding:28px;max-width:380px;width:100%}h1{font-size:1.2rem;margin:0 0 8px}p{color:#9AA5C4;font-size:.92rem}input{width:100%;box-sizing:border-box;font-size:1.4rem;letter-spacing:.4em;text-align:center;padding:12px;border-radius:10px;border:1px solid #DDBD8466;background:#060E24;color:#FCF3E3;margin:12px 0}button{width:100%;padding:12px;border:0;border-radius:999px;background:#DDBD84;color:#0A1737;font-weight:700;font-size:1rem;cursor:pointer}.msg{color:#FCF3E3;background:#060E24;border-radius:10px;padding:10px;margin-top:14px}</style></head>
<body><form method="post"><h1>Registrar o número do bot</h1><p>Crie um PIN de 6 números para a verificação em duas etapas do WhatsApp da Divinus. Guarde esse PIN: a Meta pode pedir de novo no futuro.</p>
<input name="pin" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="off" required placeholder="••••••"><button type="submit">Registrar</button>${msg ? `<div class="msg">${esc(msg)}</div>` : ""}</form></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const stub = (env, waId) => env.CONVERSA.get(env.CONVERSA.idFromName(waId));

async function validSignature(body, header, secret) {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export { Painel, Demos };

// ---------------------------------------------------------------- Conversa (1 por cliente)

export class Conversa extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/inbound") return this.inbound(await request.json());
    if (path === "/human") {
      const s = await this.load();
      s.humanUntil = Date.now() + HUMAN_PAUSE;
      await this.save(s);
      await this.ctx.storage.deleteAlarm();
      return new Response("ok");
    }
    if (path === "/get") return Response.json(await this.load());
    if (path === "/reply") {
      // Resposta da equipe pelo painel: envia, registra e pausa o bot nesta conversa.
      const { text, resumeBot } = await request.json();
      const s = await this.load();
      if (resumeBot) {
        s.humanUntil = 0;
        await this.save(s);
        return Response.json({ ok: true });
      }
      if (!text?.trim()) return Response.json({ ok: false, error: "Mensagem vazia." }, { status: 400 });
      if (Date.now() > s.lastUserAt + 24 * HOUR) {
        return Response.json({ ok: false, error: "Passaram 24 h desde a última mensagem do cliente; o WhatsApp só permite mensagem modelo aprovada." }, { status: 400 });
      }
      try {
        await sendText(this.env, s.waId, text.trim());
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) }, { status: 502 });
      }
      s.history.push({ role: "assistant", content: text.trim(), by: "equipe", at: Date.now() });
      s.lastBotAt = Date.now();
      s.humanUntil = Date.now() + HUMAN_PAUSE;
      await this.save(s);
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  async load() {
    return (await this.ctx.storage.get("s")) || {
      waId: "", name: "", history: [], seen: [],
      lastUserAt: 0, lastBotAt: 0, stage: 0,
      lead: false, optOut: false, humanUntil: 0, pending: "",
    };
  }
  async save(s) {
    await this.ctx.storage.put("s", s);
    if (!s.waId) return;
    // Atualiza a lista do painel (não pode derrubar o atendimento se falhar).
    const last = s.history.at(-1);
    try {
      await painel(this.env).fetch("https://painel/upsert", {
        method: "POST",
        body: JSON.stringify({
          waId: s.waId, name: s.name, lead: s.lead, servico: s.leadInfo?.servico || "",
          optOut: s.optOut, human: s.humanUntil > Date.now(),
          lastText: last ? last.content.slice(0, 140) : "", lastFrom: last ? (last.by || last.role) : "",
          lastAt: Math.max(s.lastUserAt, s.lastBotAt), lastUserAt: s.lastUserAt,
        }),
      });
    } catch (e) {
      console.log("painel upsert error", String(e));
    }
  }

  async inbound({ id, from, name, text, type }) {
    let s = await this.load();
    if (s.seen.includes(id)) return new Response("dup");     // a Meta pode reenviar
    s.seen = [...s.seen.slice(-19), id];
    s.waId = from;
    if (name && !s.name) s.name = name;
    s.lastUserAt = Date.now();
    s.stage = 0;
    await this.ctx.storage.deleteAlarm();
    await markRead(this.env, id);

    if (!text) {                                           // áudio, imagem, figurinha...
      await this.save(s);
      if (type !== "reaction" && !this.humanActive(s)) await this.say(s, MEDIA_REPLY);
      return new Response("media");
    }

    // Junta mensagens seguidas do cliente num único turno.
    const last = s.history.at(-1);
    if (last?.role === "user") { last.content += "\n" + text; last.at = Date.now(); }
    else s.history.push({ role: "user", content: text, at: Date.now() });
    s.pending = id;
    await this.save(s);

    if (this.humanActive(s)) return new Response("human");  // equipe está conversando

    if (s.optOut) {
      // Quem pediu para parar e voltou a escrever reabre a conversa normalmente.
      s.optOut = false;
      await this.save(s);
    }

    // Espera alguns segundos: se chegar outra mensagem, só a última dispara a resposta.
    await sleep(DEBOUNCE_MS);
    s = await this.load();
    if (s.pending !== id) return new Response("debounced");

    try {
      const reply = await this.think(s);
      if (reply) await this.say(s, reply);
      await this.scheduleNext(s);
    } catch (e) {
      console.log("reply failed", String(e));
    }
    return new Response("ok");
  }

  humanActive(s) { return s.humanUntil > Date.now(); }

  async think(s) {
    const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY, maxRetries: 2 });
    const today = new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 16).replace("T", " ");
    const system = `${SYSTEM}\nAgora em Belém: ${today}.${s.name ? ` Nome no perfil do WhatsApp: ${s.name}.` : ""}${s.lead ? " O resumo deste cliente JÁ foi enviado à equipe; não use registrar_lead de novo." : ""}`;
    const messages = s.history.map((m) => ({ role: m.role, content: m.content }));

    try {
      for (let round = 0; round < 3; round++) {
        const res = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          system,
          tools: TOOLS,
          messages,
        });
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (res.stop_reason !== "tool_use") return text || null;

        messages.push({ role: "assistant", content: res.content });
        const results = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          results.push({ type: "tool_result", tool_use_id: block.id, content: await this.runTool(s, block.name, block.input) });
        }
        messages.push({ role: "user", content: results });
      }
    } catch (error) {
      console.log("Claude error", error?.status, String(error?.message || error));
      if (error instanceof Anthropic.APIError) {
        return "Tive uma instabilidade aqui 😅 Já avisei a equipe e alguém te responde em breve.";
      }
      throw error;
    }
    return null;
  }

  async runTool(s, name, input) {
    if (name === "registrar_lead") {
      if (s.lead) return "Resumo já enviado antes.";
      s.lead = true;
      s.leadInfo = { ...(input || {}), at: Date.now() };
      if (input?.nome) s.name = input.nome;
      await this.save(s);
      try {
        await sendLeadEmail(this.env, s, input || {});
        return "Resumo enviado para a equipe.";
      } catch (e) {
        console.log("email error", String(e));
        return "Não consegui enviar o e-mail, mas a equipe verá a conversa no WhatsApp.";
      }
    }
    if (name === "encerrar_contato") {
      s.optOut = true;
      await this.save(s);
      await this.ctx.storage.deleteAlarm();
      return "Contato encerrado. Não envie mais lembretes. Despeça-se com educação em uma frase.";
    }
    return "Ferramenta desconhecida.";
  }

  async say(s, text) {
    await sendText(this.env, s.waId, text);
    s.history.push({ role: "assistant", content: text, at: Date.now() });
    if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
    // A conversa precisa começar pelo cliente.
    while (s.history.length && s.history[0].role !== "user") s.history.shift();
    s.lastBotAt = Date.now();
    await this.save(s);
  }

  // Agenda o próximo lembrete conforme a etapa atual.
  async scheduleNext(s) {
    if (s.optOut || s.lead || s.stage >= FOLLOWUPS.length) return;
    const step = FOLLOWUPS[s.stage];
    const base = step.after < HOUR ? s.lastBotAt : s.lastUserAt;
    let when = daytime(base + step.after);
    // Texto livre só dentro de 24h desde a última mensagem do cliente; senão pula para o próximo.
    if (step.kind === "text" && when > s.lastUserAt + 23.5 * HOUR) {
      s.stage++;
      await this.save(s);
      return this.scheduleNext(s);
    }
    await this.ctx.storage.setAlarm(when);
  }

  async alarm() {
    const s = await this.load();
    if (s.optOut || s.lead || this.humanActive(s) || s.stage >= FOLLOWUPS.length) return;
    if (s.lastUserAt > s.lastBotAt) return;               // cliente respondeu e ainda não foi atendido
    const step = FOLLOWUPS[s.stage];
    try {
      if (step.kind === "text") {
        if (Date.now() > s.lastUserAt + 23.9 * HOUR) throw new Error("fora da janela de 24h");
        await this.say(s, step.text(s.name));
      } else {
        await sendTemplate(this.env, s.waId, step.template, firstName(s.name));
        s.history.push({ role: "assistant", content: `[lembrete automático: ${step.template}]` });
        s.lastBotAt = Date.now();
      }
    } catch (e) {
      console.log("follow-up error", step.template || "text", String(e));
    }
    s.stage++;
    await this.save(s);
    await this.scheduleNext(s);
  }
}

// ---------------------------------------------------------------- WhatsApp Cloud API

async function graph(env, body) {
  const res = await fetch(`https://graph.facebook.com/${env.GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
  return res.json();
}

const sendText = (env, to, text) =>
  graph(env, { recipient_type: "individual", to, type: "text", text: { body: text, preview_url: true } });

const sendTemplate = (env, to, name, nome) =>
  graph(env, {
    to, type: "template",
    template: { name, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: nome }] }] },
  });

async function markRead(env, id) {
  try { await graph(env, { status: "read", message_id: id }); } catch (e) { console.log("read error", String(e)); }
}

// ---------------------------------------------------------------- E-mail para a equipe

async function sendLeadEmail(env, s, lead) {
  const tel = s.waId.replace(/^55(\d{2})(\d+)$/, "($1) $2");
  const lines = [
    `Novo cliente pelo WhatsApp da Divinus`,
    ``,
    `Nome: ${lead.nome || s.name || "-"}`,
    `Empresa: ${lead.empresa || "-"}`,
    `Serviço: ${lead.servico || "-"}`,
    `Necessidade: ${lead.necessidade || "-"}`,
    `Disponibilidade para o diagnóstico: ${lead.disponibilidade || "-"}`,
    `WhatsApp: ${tel}  https://wa.me/${s.waId}`,
    ``,
    `--- Conversa ---`,
    ...s.history.map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`),
  ];
  const subject = `Novo cliente: ${lead.nome || s.name || s.waId} (${lead.servico || "WhatsApp"})`;
  const mime = [
    `From: Bot Divinus <${env.FROM_EMAIL}>`,
    `To: ${env.TEAM_EMAIL}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@divinustecnologia.com.br>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(lines.join("\n")).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  await env.TEAM_MAIL.send(new EmailMessage(env.FROM_EMAIL, env.TEAM_EMAIL, mime));
}

// ---------------------------------------------------------------- utilidades

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "tudo bem";
const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

// Lembretes só entre 9h e 20h de Belém.
function daytime(ts) {
  const local = new Date(ts + TZ_OFFSET);
  const h = local.getUTCHours();
  if (h >= 9 && h < 20) return ts;
  const next = new Date(local);
  if (h >= 20) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(9, 0, 0, 0);
  return next.getTime() - TZ_OFFSET;
}
