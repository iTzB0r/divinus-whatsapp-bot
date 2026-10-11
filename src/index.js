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
    return new Response("not found", { status: 404 });
  }

  async load() {
    return (await this.ctx.storage.get("s")) || {
      waId: "", name: "", history: [], seen: [],
      lastUserAt: 0, lastBotAt: 0, stage: 0,
      lead: false, optOut: false, humanUntil: 0, pending: "",
    };
  }
  save(s) { return this.ctx.storage.put("s", s); }

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
    if (last?.role === "user") last.content += "\n" + text;
    else s.history.push({ role: "user", content: text });
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
    s.history.push({ role: "assistant", content: text });
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
