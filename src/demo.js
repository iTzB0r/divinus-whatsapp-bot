// Gerador de sites de demonstração (demo.divinustecnologia.com.br).
// GET  /gerador          -> tela para criar demos (login do painel)
// POST /gerador/salvar   -> salva uma demo
// POST /gerador/apagar   -> apaga uma demo
// GET  /{slug}           -> site de demonstração da empresa
// POST /api/chat         -> chatbot da demonstração
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { ICONS, PRESETS } from "./demo-presets.js";

export const DEMO_HOST = "demo.divinustecnologia.com.br";
const MAX_TURNS = 14;
const MAX_CHARS = 500;

const store = (env) => env.DEMOS.get(env.DEMOS.idFromName("main"));

// Exemplos fixos, públicos, usados no site da Divinus ("Veja funcionando").
const EXAMPLES = {
  "exemplo-otica": { slug: "exemplo-otica", name: "Ótica Visão Clara", segment: "otica", city: "Belém", color: "#1F4E8C", whatsapp: "", logo: "" },
};
async function findDemo(env, slug) {
  if (EXAMPLES[slug]) return EXAMPLES[slug];
  return (await store(env).fetch(`https://d/get?slug=${slug}`)).json();
}

// Guarda as configurações das demos (uma instância só).
export class Demos extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (url.pathname === "/get") return Response.json((await this.ctx.storage.get(`d:${slug}`)) || null);
    if (url.pathname === "/put") {
      const d = await request.json();
      await this.ctx.storage.put(`d:${d.slug}`, d);
      return new Response("ok");
    }
    if (url.pathname === "/delete") {
      await this.ctx.storage.delete(`d:${slug}`);
      return new Response("ok");
    }
    if (url.pathname === "/list") {
      const all = await this.ctx.storage.list({ prefix: "d:" });
      return Response.json([...all.values()].map(({ logo, ...d }) => ({ ...d, hasLogo: !!logo })).sort((a, b) => b.createdAt - a.createdAt));
    }
    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------- utilidades

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.star}</svg>`;
const initials = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || name[0].toUpperCase();

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * t));
function luminance(h) {
  const [r, g, b] = hexToRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Garante contraste: se a cor for clara demais para texto em fundo branco, escurece.
function brandColors(c) {
  let primary = c;
  while (luminance(primary) > 0.32) primary = mix(primary, "#000000", 0.12);
  return {
    primary,
    onPrimary: luminance(primary) > 0.45 ? "#111111" : "#FFFFFF",
    dark: mix(primary, "#0B0B12", 0.72),
    tint: mix(primary, "#FFFFFF", 0.92),
    soft: mix(primary, "#FFFFFF", 0.82),
  };
}

const waLink = (num, text) => num ? `https://wa.me/${num}?text=${encodeURIComponent(text)}` : "#contato";

// ---------------------------------------------------------------- roteamento

export async function handleDemo(url, request, env, authorized) {
  const path = url.pathname;

  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (path === "/api/chat" && request.method === "POST") return demoChat(request, env);

  if (path === "/gerador" || path.startsWith("/gerador/")) {
    if (!authorized(request, env)) {
      return new Response("Acesso restrito", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Gerador Divinus", charset="UTF-8"' } });
    }
    if (path === "/gerador/salvar" && request.method === "POST") return saveDemo(request, env);
    if (path === "/gerador/apagar" && request.method === "POST") {
      const { slug } = await request.json();
      await store(env).fetch(`https://d/delete?slug=${encodeURIComponent(slug)}`);
      return Response.json({ ok: true });
    }
    return generatorPage(env);
  }

  const slug = path.replace(/^\/+|\/+$/g, "");
  if (slug && /^[a-z0-9-]+$/.test(slug)) {
    const demo = await findDemo(env, slug);
    if (demo) return html(sitePage(demo));
  }
  return html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Divinus</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0A1737;color:#FCF3E3;font-family:system-ui,sans-serif;text-align:center;padding:16px"><div><p style="letter-spacing:.2em;font-weight:700">DIVINUS</p><p style="color:#9AA5C4">Demonstração não encontrada.</p><p><a style="color:#DDBD84" href="https://divinustecnologia.com.br">divinustecnologia.com.br</a></p></div></body></html>`, 404);
}

const html = (body, status = 200) => new Response(body, {
  status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
});

// ---------------------------------------------------------------- salvar demo

async function saveDemo(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || "").trim().slice(0, 60);
  const segment = PRESETS[b.segment] ? b.segment : null;
  const color = /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : null;
  const whatsapp = String(b.whatsapp || "").replace(/\D/g, "").slice(0, 15);
  const logo = typeof b.logo === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo) && b.logo.length < 400_000 ? b.logo : "";
  const city = String(b.city || "").trim().slice(0, 40);
  if (!name || !segment) return Response.json({ ok: false, error: "Informe o nome e o ramo." }, { status: 400 });
  const slug = slugify(b.slug || name);
  if (!slug) return Response.json({ ok: false, error: "Nome inválido." }, { status: 400 });
  const prev = await (await store(env).fetch(`https://d/get?slug=${slug}`)).json();
  await store(env).fetch("https://d/put", {
    method: "POST",
    body: JSON.stringify({
      slug, name, segment, city, whatsapp,
      color: color || PRESETS[segment].color,
      logo: logo || (b.keepLogo && prev?.logo) || "",
      createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(),
    }),
  });
  return Response.json({ ok: true, slug, url: `https://${DEMO_HOST}/${slug}` });
}

// ---------------------------------------------------------------- chat da demo

async function demoChat(request, env) {
  const json = (d, s = 200) => Response.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
  const origin = request.headers.get("Origin") || "";
  if (origin && origin !== `https://${DEMO_HOST}` && env.DEMO_LOCAL !== "1") return json({ error: "Origem não permitida." }, 403);
  const body = await request.json().catch(() => null);
  const demo = body?.slug && /^[a-z0-9-]+$/.test(body.slug) ? await findDemo(env, body.slug) : null;
  if (!demo || !Array.isArray(body.messages) || !body.messages.length) return json({ error: "Requisição inválida." }, 400);

  const messages = [];
  for (const [i, m] of body.messages.entries()) {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== role || typeof m.content !== "string" || !m.content.trim()) return json({ error: "Requisição inválida." }, 400);
    if (role === "user" && m.content.length > MAX_CHARS) return json({ error: `Mensagem muito longa (máximo ${MAX_CHARS} caracteres).` }, 400);
    messages.push({ role, content: m.content.slice(0, 3000) });
  }
  if (messages.at(-1).role !== "user") return json({ error: "Requisição inválida." }, 400);
  if (messages.filter((m) => m.role === "user").length > MAX_TURNS) return json({ error: "Esta demonstração chegou ao limite de mensagens. Recarregue a página para testar de novo." }, 429);

  const p = PRESETS[demo.segment];
  const system = `Você é a assistente virtual da *${demo.name}* (${p.label.toLowerCase()}${demo.city ? `, em ${demo.city}` : ""}), atendendo pelo site e pelo WhatsApp.
Isto é uma DEMONSTRAÇÃO feita pela Divinus para mostrar ao dono da ${demo.name} como funcionaria um atendente virtual. Atue no papel da empresa, de forma natural.
${p.facts}
Horário de exemplo: segunda a sábado, 8h às 18h.
Regras:
- Português do Brasil, tom de WhatsApp: 1 a 3 frases, simpático e objetivo, no máximo 1 emoji. Sem títulos, tabelas ou markdown; destaque com *asteriscos*.
- Você não tem preços, endereço, estoque nem agenda reais desta empresa. Quando perguntarem, diga que a equipe confirma os valores e, para agendar/pedir, peça nome e o melhor dia e horário e confirme o pedido. Ao confirmar, acrescente: "(demonstração: nada foi agendado de verdade)".
- Nunca invente nomes de profissionais, preços, promoções ou endereço.
- Se pedirem algo fora do assunto da empresa, recuse com gentileza e volte ao atendimento.
- Se perguntarem quem criou você ou se é um robô: diga que é o assistente virtual da ${demo.name}, uma demonstração criada pela Divinus (divinustecnologia.com.br).`;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
    const res = await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 1024, system, messages });
    if (res.stop_reason === "refusal") return json({ reply: "Desculpe, não consigo ajudar com isso. Posso ajudar com informações ou um agendamento?" });
    const reply = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return json({ reply: reply || "Pode repetir, por favor?" });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: "Muitas conversas ao mesmo tempo. Tente de novo em instantes." }, 429);
    console.log("demo chat error", error?.status, String(error?.message || error));
    return json({ error: "Não consegui responder agora. Tente de novo." }, 500);
  }
}

// ---------------------------------------------------------------- site da demo

function sitePage(d) {
  const p = PRESETS[d.segment];
  const c = brandColors(d.color);
  const n = esc(d.name);
  const hero = esc(p.hero).replace("{nome}", `<span class="nm">${n}</span>`);
  const wa = waLink(d.whatsapp, `Olá, ${d.name}! Vim pelo site.`);
  const logo = d.logo ? `<img src="${d.logo}" alt="${n}">` : `<span class="mono">${esc(initials(d.name))}</span>`;
  const year = new Date().getFullYear();
  const preview = { otica: "Claro! O exame é feito com hora marcada. Tenho horários amanhã de manhã e à tarde, qual fica melhor para você?",
    oficina: "Posso sim! A revisão inclui itens de segurança, óleo e filtros. Qual o modelo e o ano do seu carro?",
    clinica: "Com certeza! Qual especialidade você procura e qual o melhor dia para você?",
    restaurante: "Oi! Hoje temos opções de prato do dia e grelhados. Vai querer delivery ou retirada?",
    roupas: "Chegaram peças novas sim! Posso te mandar as fotos. Você procura algo para qual ocasião?",
    salao: "Temos horários sim! Para qual dia você prefere e com qual profissional?" }[d.segment];
  const chips = { otica: ["Quanto custa o exame de vista?", "Vocês fazem lentes multifocais?", "Quero agendar um exame"],
    oficina: ["Quanto custa uma revisão?", "Meu carro está fazendo barulho no freio", "Vocês fazem leva e traz?"],
    clinica: ["Quero marcar uma consulta", "Vocês atendem convênio?", "Tem teleconsulta?"],
    restaurante: ["Qual o cardápio de hoje?", "Vocês entregam no meu bairro?", "Quero reservar para 8 pessoas"],
    roupas: ["Chegou novidade essa semana?", "Vocês entregam?", "Como funciona a troca?"],
    salao: ["Quero agendar corte e escova", "Quanto custa mechas?", "Tem horário no sábado?"] }[d.segment];

  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${n} | ${esc(p.label)}</title>
<meta name="theme-color" content="${c.primary}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--p:${c.primary};--on:${c.onPrimary};--dark:${c.dark};--tint:${c.tint};--soft:${c.soft};--ink:#16161D;--muted:#5D5D6B;--bg:#FFFFFF;--line:#E7E7EE}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:"DM Sans",system-ui,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit}:focus-visible{outline:3px solid var(--p);outline-offset:3px;border-radius:6px}
h1,h2,h3{font-family:"Sora",system-ui,sans-serif;letter-spacing:-.02em;margin:0;line-height:1.12}
.wrap{max-width:1140px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
.btn{font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:10px;padding:14px 24px;border-radius:999px;font-weight:600;text-decoration:none;border:2px solid transparent;transition:transform .15s,background .2s}
.btn:hover{transform:translateY(-1px)}.btn-p{background:var(--p);color:var(--on)}.btn-o{border-color:var(--p);color:var(--p);background:transparent}
.btn svg{width:20px;height:20px;fill:currentColor}
.demo-bar{background:var(--dark);color:#fff;text-align:center;font-size:.82rem;padding:7px 12px}.demo-bar a{color:#fff;font-weight:600}
header{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;height:70px;gap:16px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-family:"Sora";font-weight:700;font-size:1.1rem}
.brand img{height:42px;width:auto;max-width:150px;object-fit:contain}
.mono{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--p);color:var(--on);font-size:1rem}
nav{display:flex;gap:26px;font-size:.95rem}nav a{text-decoration:none;color:var(--muted)}nav a:hover{color:var(--p)}
.hero{background:linear-gradient(180deg,var(--tint),#fff);padding:clamp(56px,9vw,110px) 0 clamp(56px,8vw,90px);position:relative;overflow:hidden}
.hero .wrap{display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center}
.hero h1{font-size:clamp(2.2rem,5vw,3.8rem);max-width:15ch}.nm{color:var(--p)}
.hero p{font-size:1.15rem;color:var(--muted);max-width:52ch;margin:22px 0 32px}
.cta{display:flex;flex-wrap:wrap;gap:12px}
.phone{background:#fff;border:1px solid var(--line);border-radius:28px;overflow:hidden;box-shadow:0 40px 80px -30px rgba(20,20,40,.35);max-width:400px;justify-self:end;width:100%}
.ph-top{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--p);color:var(--on)}.ph-top b{display:block}.ph-top small{opacity:.85;font-size:.8rem}
.ph-top .av{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-family:"Sora";font-weight:700;overflow:hidden}.ph-top .av img{width:100%;height:100%;object-fit:contain;background:#fff}
.ph-body{background:#F3F4F7;padding:16px;display:flex;flex-direction:column;gap:8px;min-height:230px}
.ph-cta{display:block;width:100%;border:0;border-top:1px solid var(--line);background:#fff;color:var(--p);font:inherit;font-weight:700;padding:15px;cursor:pointer}.ph-cta:hover{background:var(--tint)}
@media (max-width:900px){.phone{justify-self:stretch;max-width:none}}
.card-hero{background:#fff;border:1px solid var(--line);border-radius:24px;padding:26px;box-shadow:0 30px 60px -30px rgba(20,20,40,.25)}
.card-hero h3{font-size:1.05rem;margin-bottom:14px}.card-hero ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.card-hero li{display:flex;gap:12px;align-items:center;font-weight:500}.card-hero li span{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:var(--soft)}
svg{display:block}.card-hero svg,.svc svg,.perk svg{width:20px;height:20px;fill:none;stroke:var(--p);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
section{scroll-margin-top:80px}.sec{padding:clamp(64px,9vw,104px) 0}
.sec-head{max-width:640px;margin-bottom:40px}.sec-head h2{font-size:clamp(1.8rem,3.4vw,2.6rem)}.sec-head p{color:var(--muted);font-size:1.08rem;margin-top:12px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.svc{border:1px solid var(--line);border-radius:18px;padding:24px;background:#fff;transition:border-color .2s}.svc:hover{border-color:var(--p)}
.svc .ic{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:var(--tint);margin-bottom:16px}.svc .ic svg{width:22px;height:22px}
.svc h3{font-size:1.1rem;margin-bottom:6px}.svc p{color:var(--muted);margin:0;font-size:.97rem}
.band{background:var(--dark);color:#fff}.band .grid{grid-template-columns:repeat(3,1fr)}
.perk{display:flex;gap:14px;align-items:center;font-family:"Sora";font-weight:600;font-size:1.05rem}
.perk span{flex:none;display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:rgba(255,255,255,.1)}.perk svg{stroke:#fff}
.contact{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:start}
.box{border:1px solid var(--line);border-radius:20px;padding:26px;background:var(--tint)}
.box dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 18px;margin:0}.box dt{color:var(--muted)}.box dd{margin:0;font-weight:500}
.hint{font-size:.85rem;color:var(--muted);margin-top:12px}
footer{border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:.9rem}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
.fab{position:fixed;right:20px;bottom:20px;z-index:40;display:flex;flex-direction:column;gap:12px;align-items:flex-end}
.fab button,.fab a{width:58px;height:58px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;box-shadow:0 12px 26px -10px rgba(0,0,0,.45)}
.fab .wa{background:#25D366}.fab .wa svg{width:30px;fill:#fff}.fab .bot{background:var(--p)}.fab .bot svg{width:26px;fill:none;stroke:var(--on);stroke-width:1.9}
.chat{position:fixed;right:20px;bottom:96px;z-index:50;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 130px));background:#fff;border-radius:20px;box-shadow:0 30px 70px -20px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line)}
.chat[hidden]{display:none}.chat-top{background:var(--p);color:var(--on);padding:14px 16px;display:flex;align-items:center;gap:12px}
.chat-top .av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-weight:700;font-family:"Sora";overflow:hidden}.chat-top .av img{width:100%;height:100%;object-fit:contain;background:#fff}
.chat-top b{display:block;font-size:.98rem}.chat-top small{opacity:.85}.chat-top .x{margin-left:auto;background:none;border:0;color:var(--on);font-size:1.4rem;cursor:pointer;line-height:1}
.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#F6F6F9}
.m{max-width:85%;padding:9px 12px;border-radius:14px;font-size:.93rem;white-space:pre-wrap;overflow-wrap:anywhere}.m.in{background:#fff;border:1px solid var(--line);align-self:flex-start;border-bottom-left-radius:4px}.m.out{background:var(--p);color:var(--on);align-self:flex-end;border-bottom-right-radius:4px}.m.err{align-self:center;color:#B42318;font-size:.82rem;background:#FEE4E2}
.typing{align-self:flex-start;display:flex;gap:4px;padding:12px;background:#fff;border-radius:14px;border:1px solid var(--line)}.typing i{width:6px;height:6px;border-radius:50%;background:#999;animation:b 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes b{50%{opacity:.3}}
.chips{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;background:#F6F6F9}.chips[hidden]{display:none}.chips button{flex:none;border:1px solid var(--p);color:var(--p);background:#fff;border-radius:999px;padding:5px 11px;font-size:.8rem;cursor:pointer;white-space:nowrap}
.chat form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}.chat input{flex:1;border:1px solid var(--line);border-radius:999px;padding:10px 14px;font:inherit}.chat form button{width:42px;height:42px;border-radius:50%;border:0;background:var(--p);color:var(--on);cursor:pointer;font-weight:700}
.chat .note{text-align:center;font-size:.72rem;color:var(--muted);padding:0 10px 8px}
@media (max-width:900px){.hero .wrap,.contact{grid-template-columns:1fr}.grid,.band .grid{grid-template-columns:1fr 1fr}nav{display:none}}
@media (max-width:560px){.grid,.band .grid{grid-template-columns:1fr}.btn{width:100%;justify-content:center}header .btn{display:none}.brand{font-size:1rem}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style></head><body>
<div class="demo-bar">Demonstração criada pela <a href="https://divinustecnologia.com.br" target="_blank" rel="noopener">Divinus</a> para ${n}</div>
<header><div class="wrap"><a class="brand" href="#">${logo}<span>${n}</span></a>
<nav aria-label="Principal"><a href="#servicos">Serviços</a><a href="#diferenciais">Diferenciais</a><a href="#contato">Contato</a></nav>
<a class="btn btn-p" href="${esc(wa)}" target="_blank" rel="noopener" style="padding:10px 18px">WhatsApp</a></div></header>
<main>
<section class="hero"><div class="wrap"><div>
<h1>${hero}</h1><p>${esc(p.sub)}</p>
<div class="cta"><a class="btn btn-p" href="${esc(wa)}" target="_blank" rel="noopener">${esc(p.cta)}</a><button class="btn btn-o" type="button" data-open-chat>Falar com a assistente virtual</button></div>
</div>
<div class="phone" aria-label="Prévia da assistente virtual">
<div class="ph-top"><span class="av">${d.logo ? `<img src="${d.logo}" alt="">` : esc(initials(d.name))}</span><div><b>${n}</b><small>online agora</small></div></div>
<div class="ph-body"><div class="m in">Olá! 😊 Sou a assistente virtual da ${n}. Como posso ajudar?</div><div class="m out">${esc(chips[2])}</div><div class="m in">${esc(preview)}</div></div>
<button type="button" class="ph-cta" data-open-chat>Testar a assistente agora</button></div>
</div></section>

<section class="sec" id="servicos"><div class="wrap">
<div class="sec-head"><h2>O que fazemos</h2><p>Tudo o que você precisa, com qualidade e atendimento próximo${d.city ? ` em ${esc(d.city)}` : ""}.</p></div>
<div class="grid">${p.services.map(([i, t, desc]) => `<article class="svc"><div class="ic">${icon(i)}</div><h3>${esc(t)}</h3><p>${esc(desc)}</p></article>`).join("")}</div>
</div></section>

<section class="sec band" id="diferenciais"><div class="wrap"><div class="grid">${p.perks.map(([i, t]) => `<div class="perk"><span>${icon(i)}</span>${esc(t)}</div>`).join("")}</div></div></section>

<section class="sec" id="contato"><div class="wrap contact">
<div class="sec-head" style="margin:0"><h2>Fale com a ${n}</h2><p>Atendimento rápido pelo WhatsApp ou pela nossa assistente virtual, a qualquer hora.</p>
<div class="cta" style="margin-top:24px"><a class="btn btn-p" href="${esc(wa)}" target="_blank" rel="noopener">${esc(p.cta)}</a></div></div>
<div class="box"><dl><dt>Endereço</dt><dd>${d.city ? esc(d.city) : "Endereço da empresa"}</dd><dt>Horário</dt><dd>Segunda a sábado, 8h às 18h</dd><dt>WhatsApp</dt><dd>${d.whatsapp ? esc(d.whatsapp.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3")) : "Seu número aqui"}</dd></dl>
<p class="hint">Na versão final, endereço, mapa, horários, fotos e depoimentos reais da empresa.</p></div>
</div></section>
</main>
<footer><div class="wrap"><span>© ${year} ${n}</span><span>Site e assistente virtual por <a href="https://divinustecnologia.com.br" target="_blank" rel="noopener">Divinus</a></span></div></footer>

<div class="fab">
<button class="bot" type="button" data-open-chat aria-label="Abrir assistente virtual"><svg viewBox="0 0 24 24">${ICONS.chat}</svg></button>
<a class="wa" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l2 .9c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg></a>
</div>
<section class="chat" id="chat" hidden aria-label="Assistente virtual">
<div class="chat-top"><div class="av">${d.logo ? `<img src="${d.logo}" alt="">` : esc(initials(d.name))}</div><div><b>${n}</b><small>Assistente virtual · online</small></div><button class="x" type="button" id="close" aria-label="Fechar">×</button></div>
<div class="msgs" id="msgs" aria-live="polite"></div>
<div class="chips" id="chips">${chips.map((t) => `<button type="button">${esc(t)}</button>`).join("")}</div>
<form id="f"><input id="i" maxlength="${MAX_CHARS}" placeholder="Escreva sua mensagem" autocomplete="off" aria-label="Mensagem"><button type="submit" aria-label="Enviar">➤</button></form>
<p class="note">Demonstração com inteligência artificial · Divinus</p>
</section>
<script>
(() => {
  const SLUG = ${JSON.stringify(d.slug)}, NAME = ${JSON.stringify(d.name)};
  const chat = document.getElementById('chat'), msgs = document.getElementById('msgs'), chips = document.getElementById('chips'), input = document.getElementById('i');
  let history = [], busy = false, started = false;
  const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const add = (t, k) => { const e = document.createElement('div'); e.className = 'm ' + k; e.innerHTML = k === 'err' ? esc(t) : esc(t).replace(/\\*([^*\\n]+)\\*/g, '<strong>$1</strong>'); msgs.appendChild(e); msgs.scrollTop = msgs.scrollHeight; };
  const open = () => { chat.hidden = false; if (!started) { started = true; add('Olá! 😊 Sou a assistente virtual da ' + NAME + '. Como posso ajudar?', 'in'); } input.focus(); };
  document.querySelectorAll('[data-open-chat]').forEach(b => b.addEventListener('click', open));
  document.getElementById('close').addEventListener('click', () => { chat.hidden = true; });
  async function ask(t) {
    t = t.trim(); if (!t || busy) return; busy = true; chips.hidden = true; add(t, 'out'); input.value = '';
    history.push({ role: 'user', content: t });
    const ty = document.createElement('div'); ty.className = 'typing'; ty.innerHTML = '<i></i><i></i><i></i>'; msgs.appendChild(ty); msgs.scrollTop = msgs.scrollHeight;
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: SLUG, messages: history }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.reply) throw new Error(d.error || 'Não consegui responder agora.');
      history.push({ role: 'assistant', content: d.reply }); add(d.reply, 'in');
    } catch (e) { history.pop(); add(e.message, 'err'); }
    finally { ty.remove(); busy = false; }
  }
  chips.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') ask(e.target.textContent); });
  document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
})();
</script></body></html>`;
}

// ---------------------------------------------------------------- gerador

async function generatorPage(env) {
  const list = await (await store(env).fetch("https://d/list")).json();
  const options = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" data-color="${p.color}">${esc(p.label)}</option>`).join("");
  return html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Gerador de demos · Divinus</title>
<style>
:root{--navy:#0A1737;--abyss:#060E24;--panel:#0E1D45;--gold:#DDBD84;--cream:#FCF3E3;--mist:#9AA5C4;--line:rgba(221,189,132,.2)}
*{box-sizing:border-box}body{margin:0;background:var(--abyss);color:var(--cream);font-family:system-ui,"Segoe UI",sans-serif;line-height:1.5}
header{padding:14px 20px;border-bottom:1px solid var(--line);background:var(--navy);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}header b{letter-spacing:.14em}
main{max-width:860px;margin:0 auto;padding:20px 16px 60px}h1{font-size:1.4rem;margin:6px 0 4px}.muted{color:var(--mist);font-size:.9rem}
form,.item{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px}
label{display:block;font-size:.88rem;color:var(--mist);margin:12px 0 6px}input,select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--abyss);color:var(--cream);font:inherit}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.colors{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.colors button{width:30px;height:30px;border-radius:50%;border:2px solid transparent;cursor:pointer}
.colors input[type=color]{width:46px;height:34px;padding:2px;border-radius:8px}
button.main{margin-top:18px;width:100%;padding:13px;border:0;border-radius:999px;background:var(--gold);color:var(--navy);font-weight:800;font-size:1rem;cursor:pointer}
.result{margin-top:14px;padding:12px;border-radius:10px;background:var(--abyss);word-break:break-all}.result a{color:var(--gold);font-weight:700}
.item{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px;padding:14px}.dot{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:-2px;margin-right:6px}
.acts{display:flex;gap:8px;flex-wrap:wrap}.acts a,.acts button{font:inherit;font-size:.85rem;padding:7px 12px;border-radius:999px;border:1px solid var(--gold);color:var(--gold);background:transparent;text-decoration:none;cursor:pointer}
#prev{max-height:48px;margin-top:8px;display:none;background:#fff;border-radius:8px;padding:4px}
@media(max-width:560px){.row{grid-template-columns:1fr}}
</style></head><body><header><b>DIVINUS</b><span class="muted">Gerador de demonstrações</span></header><main>
<h1>Criar demonstração</h1><p class="muted">Preencha antes da visita e mostre ao cliente no celular. As demos não aparecem no Google.</p>
<form id="f">
<label for="name">Nome da empresa *</label><input id="name" required maxlength="60" placeholder="Ex.: Óticas Carol">
<div class="row"><div><label for="seg">Ramo *</label><select id="seg">${options}</select></div>
<div><label for="city">Cidade / bairro (opcional)</label><input id="city" maxlength="40" placeholder="Ex.: Belém, Umarizal"></div></div>
<label>Cor principal</label><div class="colors" id="colors"></div>
<div class="row"><div><label for="wa">WhatsApp da empresa (opcional)</label><input id="wa" inputmode="tel" placeholder="(91) 99999-9999"></div>
<div><label for="logo">Logo (opcional, PNG ou JPG)</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp"><img id="prev" alt=""></div></div>
<button class="main" type="submit">Gerar demonstração</button>
<div class="result" id="res" hidden></div>
</form>
<h1 style="margin-top:34px">Demos criadas</h1>
${list.length ? list.map((d) => `<div class="item"><div><span class="dot" style="background:${esc(d.color)}"></span><b>${esc(d.name)}</b> <span class="muted">· ${esc(PRESETS[d.segment]?.label || d.segment)}</span><div class="muted">${DEMO_HOST}/${esc(d.slug)}</div></div>
<div class="acts"><a href="/${esc(d.slug)}" target="_blank" rel="noopener">Abrir</a><button type="button" data-copy="https://${DEMO_HOST}/${esc(d.slug)}">Copiar link</button><button type="button" data-del="${esc(d.slug)}">Apagar</button></div></div>`).join("") : `<p class="muted">Nenhuma demo ainda.</p>`}
</main>
<script>
(() => {
  const swatches = ['#1F4E8C','#0F766E','#15803D','#C2410C','#B91C1C','#BE185D','#7C3AED','#111827','#A16207'];
  const box = document.getElementById('colors'), seg = document.getElementById('seg');
  const picker = document.createElement('input'); picker.type = 'color';
  swatches.forEach(c => { const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.title = c; b.onclick = () => { picker.value = c; mark(); }; box.appendChild(b); });
  box.appendChild(picker);
  const mark = () => box.querySelectorAll('button').forEach(b => b.style.borderColor = b.title.toLowerCase() === picker.value.toLowerCase() ? '#fff' : 'transparent');
  picker.oninput = mark;
  const setSeg = () => { picker.value = seg.selectedOptions[0].dataset.color; mark(); };
  seg.onchange = setSeg; setSeg();

  let logo = '';
  document.getElementById('logo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) { logo = ''; return; }
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    logo = cv.toDataURL('image/png');
    const pv = document.getElementById('prev'); pv.src = logo; pv.style.display = 'block';
  };

  const res = document.getElementById('res');
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    let wa = document.getElementById('wa').value.replace(/\\D/g, '');
    if (wa && wa.length <= 11) wa = '55' + wa;
    const r = await fetch('/gerador/salvar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('name').value, segment: seg.value, city: document.getElementById('city').value, color: picker.value, whatsapp: wa, logo }) });
    const d = await r.json().catch(() => ({}));
    res.hidden = false;
    res.innerHTML = d.ok ? 'Pronto! <a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + '</a><br><span class="muted">Recarregue esta página para ver na lista.</span>' : 'Erro: ' + (d.error || r.status);
  };
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copiado!'; });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirmar?'; return; }
    await fetch('/gerador/apagar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: b.dataset.del }) });
    b.closest('.item').remove();
  });
})();
</script></body></html>`);
}
