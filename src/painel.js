// Painel da equipe: lista de conversas, leads e resposta manual.
// Acesso com usuário "divinus" e a senha do segredo PAINEL_SENHA (autenticação básica do navegador).
import { DurableObject } from "cloudflare:workers";

export const painel = (env) => env.PAINEL.get(env.PAINEL.idFromName("main"));

// Índice das conversas (uma instância só).
export class Painel extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/upsert") {
      const c = await request.json();
      await this.ctx.storage.put(`c:${c.waId}`, c);
      return new Response("ok");
    }
    if (path === "/list") {
      const all = await this.ctx.storage.list({ prefix: "c:" });
      return Response.json([...all.values()].sort((a, b) => b.lastAt - a.lastAt));
    }
    return new Response("not found", { status: 404 });
  }
}

export function authorized(request, env) {
  if (!env.PAINEL_SENHA) return false;
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(h.slice(6)).split(/:(.*)/s);
    return user === "divinus" && pass === env.PAINEL_SENHA;
  } catch { return false; }
}

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ts) => ts ? new Date(ts).toLocaleString("pt-BR", { timeZone: "America/Belem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
const phone = (w) => w.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3");

const page = (title, body) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Painel Divinus</title>
<style>
:root{--navy:#0A1737;--abyss:#060E24;--panel:#0E1D45;--gold:#DDBD84;--cream:#FCF3E3;--mist:#9AA5C4;--line:rgba(221,189,132,.18);--ok:#7FD1A8}
*{box-sizing:border-box}body{margin:0;background:var(--abyss);color:var(--cream);font-family:system-ui,"Segoe UI",sans-serif;line-height:1.5}
a{color:var(--gold);text-decoration:none}header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--navy);position:sticky;top:0}
header b{letter-spacing:.12em}main{max-width:980px;margin:0 auto;padding:20px 16px 60px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat small{color:var(--mist)}.stat b{display:block;font-size:1.5rem}
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}.filters a{border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:.9rem;color:var(--cream)}.filters a.on{background:var(--gold);color:var(--navy);border-color:var(--gold)}
.row{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px;color:var(--cream)}.row:hover{border-color:var(--gold)}
.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.muted{color:var(--mist);font-size:.88rem}.tag{display:inline-block;font-size:.75rem;border-radius:6px;padding:1px 7px;margin-left:6px;vertical-align:1px}
.t-lead{background:var(--gold);color:var(--navy)}.t-human{background:#2C6E8F}.t-off{background:#5a2b2b}.t-wait{background:#3b3f63}
.chat{display:flex;flex-direction:column;gap:8px;margin:16px 0}.m{max-width:80%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.m small{display:block;color:var(--mist);font-size:.72rem;margin-top:3px}
.m.user{align-self:flex-start;background:#1A2B5C}.m.assistant{align-self:flex-end;background:#26345f}.m.equipe{align-self:flex-end;background:var(--gold);color:var(--navy)}.m.equipe small{color:#4a3d22}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-top:12px}textarea{width:100%;min-height:90px;background:var(--abyss);color:var(--cream);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}
button{background:var(--gold);color:var(--navy);border:0;border-radius:999px;padding:9px 18px;font-weight:700;cursor:pointer;margin-top:8px}button.ghost{background:transparent;color:var(--gold);border:1px solid var(--gold)}
.msg{margin-top:10px;padding:10px;border-radius:10px;background:var(--abyss)}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--mist)}dd{margin:0}
</style></head><body><header><a href="/painel"><b>DIVINUS</b> <span class="muted">Painel do WhatsApp</span></a><span class="muted">(91) 98128-4102</span></header><main>${body}</main></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export async function handlePainel(url, request, env, conversa) {
  if (!authorized(request, env)) {
    return new Response("Acesso restrito", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Painel Divinus", charset="UTF-8"' } });
  }

  const m = url.pathname.match(/^\/painel\/c\/(\d+)$/);
  if (m) {
    const waId = m[1];
    const stub = conversa(env, waId);
    let notice = "";
    if (request.method === "POST") {
      const form = await request.formData();
      const res = await stub.fetch("https://do/reply", {
        method: "POST",
        body: JSON.stringify({ text: form.get("text"), resumeBot: form.get("resume") === "1" }),
      });
      const out = await res.json();
      notice = out.ok ? (form.get("resume") === "1" ? "Bot reativado nesta conversa." : "Mensagem enviada. O bot fica pausado nesta conversa por 12 h.") : `Não enviado: ${out.error}`;
    }
    const s = await (await stub.fetch("https://do/get")).json();
    if (!s.waId) return page("Conversa", `<p>Conversa não encontrada. <a href="/painel">Voltar</a></p>`);
    const lead = s.leadInfo;
    const human = s.humanUntil > Date.now();
    const windowOpen = Date.now() < s.lastUserAt + 24 * 3600_000;
    return page(s.name || waId, `
<p><a href="/painel">← Todas as conversas</a></p>
<div class="top"><div><b style="font-size:1.2rem">${esc(s.name || "Sem nome")}</b>${s.lead ? '<span class="tag t-lead">pediu diagnóstico</span>' : ""}${human ? '<span class="tag t-human">equipe atendendo</span>' : ""}${s.optOut ? '<span class="tag t-off">não quer contato</span>' : ""}
<div class="muted">${phone(waId)} · <a href="https://wa.me/${esc(waId)}" target="_blank" rel="noopener">abrir no WhatsApp</a></div></div></div>
${lead ? `<div class="card"><dl><dt>Empresa</dt><dd>${esc(lead.empresa || "-")}</dd><dt>Serviço</dt><dd>${esc(lead.servico || "-")}</dd><dt>Necessidade</dt><dd>${esc(lead.necessidade || "-")}</dd><dt>Disponibilidade</dt><dd>${esc(lead.disponibilidade || "-")}</dd><dt>Pedido em</dt><dd>${when(lead.at)}</dd></dl></div>` : ""}
<div class="chat">${s.history.map((h) => {
      const cls = h.by === "equipe" ? "equipe" : h.role;
      const who = h.by === "equipe" ? "Equipe" : h.role === "user" ? "Cliente" : "Bot";
      return `<div class="m ${cls}">${esc(h.content)}<small>${who}${h.at ? " · " + when(h.at) : ""}</small></div>`;
    }).join("")}</div>
<div class="card">
${windowOpen ? `<form method="post"><label class="muted" for="t">Responder como equipe (o bot pausa nesta conversa por 12 h)</label><textarea id="t" name="text" required placeholder="Escreva a mensagem..."></textarea><button type="submit">Enviar pelo WhatsApp</button></form>`
      : `<p class="muted">Passaram mais de 24 h desde a última mensagem do cliente. O WhatsApp só permite mensagem modelo aprovada; para falar com ele agora, use o WhatsApp da equipe pelo link acima.</p>`}
${human ? `<form method="post"><input type="hidden" name="resume" value="1"><button class="ghost" type="submit">Devolver a conversa para o bot</button></form>` : ""}
${notice ? `<div class="msg">${esc(notice)}</div>` : ""}
</div>`);
  }

  // Lista
  const filter = url.searchParams.get("f") || "todas";
  const all = await (await painel(env).fetch("https://painel/list")).json();
  const day = Date.now() - 24 * 3600_000;
  const stats = {
    total: all.length,
    leads: all.filter((c) => c.lead).length,
    hoje: all.filter((c) => c.lastAt > day).length,
    aguardando: all.filter((c) => c.lastFrom === "user").length,
  };
  const list = all.filter((c) => filter === "leads" ? c.lead : filter === "aguardando" ? c.lastFrom === "user" : true);
  const f = (k, label) => `<a class="${filter === k ? "on" : ""}" href="/painel?f=${k}">${label}</a>`;
  return page("Conversas", `
<div class="stats"><div class="stat"><small>Conversas</small><b>${stats.total}</b></div><div class="stat"><small>Pediram diagnóstico</small><b>${stats.leads}</b></div><div class="stat"><small>Ativas nas últimas 24 h</small><b>${stats.hoje}</b></div><div class="stat"><small>Cliente esperando resposta</small><b>${stats.aguardando}</b></div></div>
<div class="filters">${f("todas", "Todas")}${f("leads", "Pediram diagnóstico")}${f("aguardando", "Esperando resposta")}</div>
${list.length ? list.map((c) => `<a class="row" href="/painel/c/${esc(c.waId)}"><div class="top"><span><b>${esc(c.name || phone(c.waId))}</b>${c.lead ? `<span class="tag t-lead">${esc(c.servico || "diagnóstico")}</span>` : ""}${c.human ? '<span class="tag t-human">equipe</span>' : ""}${c.optOut ? '<span class="tag t-off">parou</span>' : ""}${c.lastFrom === "user" ? '<span class="tag t-wait">esperando</span>' : ""}</span><span class="muted">${when(c.lastAt)}</span></div><div class="muted">${c.lastFrom === "user" ? "Cliente: " : c.lastFrom === "equipe" ? "Equipe: " : "Bot: "}${esc(c.lastText)}</div></a>`).join("")
    : `<p class="muted">Nenhuma conversa ainda. Quando alguém mandar mensagem para o (91) 98128-4102, ela aparece aqui.</p>`}`);
}
