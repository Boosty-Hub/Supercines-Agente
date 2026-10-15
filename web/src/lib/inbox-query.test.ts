// Tests de la capa de datos del inbox paginado (lib/inbox-query.ts) y su paridad con la base.
// Correr con: cd web && node --test src/lib/inbox-query.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendPage,
  applyPendingMoves,
  boardLimits,
  compareLeads,
  ESTADOS,
  listRefreshLimit,
  mergeBoardRefresh,
  mergeRefresh,
  revertMove,
  moveCard,
  normalizeBoard,
  parseCursor,
  parseFilters,
  parseLimit,
  parseLimits,
  parsePipeline,
  parseSort,
  parseStage,
  queryFromFilters,
  parseEtapa,
  RANGOS,
  SORTS,
  type InboxBoard,
  type InboxPage,
} from "./inbox-query.ts";
import type { LeadSummary } from "./inbox-data.ts";

const sp = (q: string) => new URLSearchParams(q);

let seq = 0;
function lead(over: Partial<LeadSummary> = {}): LeadSummary {
  seq++;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    display_name: `Lead ${seq}`,
    channel: "whatsapp",
    kommo_lead_id: seq,
    kommo_pipeline_id: 1,
    kommo_stage_id: 10,
    kommo_missing_at: null,
    last_message_at: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - seq * 60_000).toISOString(),
    msg_count: 1,
    last_content: "hola",
    last_direction: "inbound",
    last_created_at: null,
    last_vertical: null,
    has_review_pending: false,
    max_urgency: 0,
    max_toxicity: 0,
    verticals: [],
    awaiting_reply: false,
    last_reply_at: null,
    ...over,
  };
}
const cur = (l: LeadSummary) => ({ t: l.last_message_at!, id: l.id, k: null });

// ── URL ──────────────────────────────────────────────────────────────────────
test("parseFilters: lista blanca, recorta, ignora valores desconocidos", () => {
  assert.deepEqual(parseFilters(sp("q=%20Ana%20&channel=whatsapp&vertical=precios&estado=review&urgent=1&rango=7d")), {
    q: "Ana",
    channel: "whatsapp",
    vertical: "precios",
    estado: "review",
    urgent: true,
    rango: "7d",
  });
  assert.deepEqual(parseFilters(sp("estado=zzz&rango=1y&urgent=true&q=%20%20")), {});
  assert.equal(parseFilters(sp(`q=${"x".repeat(500)}`)).q!.length, 200);
});

test("SuperCines: pestaña de la lista (default «Con agente»; «todas» no filtra)", () => {
  assert.equal(parseEtapa(sp("")), "agente");
  assert.equal(parseEtapa(sp("etapa=apagadas")), "apagadas");
  assert.equal(parseEtapa(sp("etapa=nada")), "agente");
  assert.deepEqual(parseFilters(sp("etapa=apagadas")), { etapa: "apagadas" });
  assert.deepEqual(parseFilters(sp("etapa=todas")), {});
  assert.equal(queryFromFilters({ etapa: "agente" }, "recent").toString(), "etapa=agente");
});

test("parseSort / parsePipeline / parseStage / parseLimit", () => {
  assert.equal(parseSort(sp("sort=urgency")), "urgency");
  assert.equal(parseSort(sp("sort=drop table")), "recent");
  assert.equal(parsePipeline(sp("pipeline=123")), 123);
  assert.equal(parsePipeline(sp("pipeline=-1")), -1);
  assert.equal(parsePipeline(sp("pipeline=-2")), -2);
  assert.equal(parsePipeline(sp("pipeline=-3")), null);
  assert.equal(parsePipeline(sp("pipeline=0")), null);
  assert.equal(parsePipeline(sp("pipeline=1e3")), null);
  assert.equal(parsePipeline(sp("")), null);
  assert.equal(parseStage("otras"), -1);
  assert.equal(parseStage("all"), null);
  assert.equal(parseStage("900101"), 900101);
  assert.equal(parseStage("-5"), null);
  assert.equal(parseLimit("50", 30), 50);
  assert.equal(parseLimit("9999", 30), 500);
  assert.equal(parseLimit("0", 30), 30);
  assert.equal(parseLimit("abc", 30), 30);
});

test("parseCursor: acepta lo que emite la base, rechaza todo lo demás", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  assert.equal(parseCursor(null), undefined);
  assert.deepEqual(parseCursor(JSON.stringify({ t: "2026-10-01T11:00:00.123456+00:00", id, k: null })), {
    t: "2026-10-01T11:00:00.123456+00:00",
    id,
    k: null,
  });
  assert.deepEqual(parseCursor(JSON.stringify({ t: "-infinity", id, k: "4.5" })), { t: "-infinity", id, k: "4.5" });
  assert.deepEqual(parseCursor(JSON.stringify({ t: "-infinity", id })), { t: "-infinity", id, k: null });
  // Una urgencia rara del clasificador (muchos decimales) no traba la paginación.
  const raro = "4.33333333333333333333333333333";
  assert.deepEqual(parseCursor(JSON.stringify({ t: "-infinity", id, k: raro })), { t: "-infinity", id, k: raro });
  for (const bad of [
    "{",
    "[]",
    JSON.stringify({ t: "ayer", id, k: null }),
    JSON.stringify({ t: "-infinity", id: "x", k: null }),
    JSON.stringify({ t: "-infinity", id, k: "1; drop table leads" }),
    JSON.stringify({ t: "-infinity", id, k: "1e5" }),
    JSON.stringify({ t: "-infinity", id, k: "9".repeat(65) }),
    JSON.stringify({ t: "-infinity", id, k: 4 }),
  ]) {
    assert.equal(parseCursor(bad), null, bad);
  }
});

test("parseLimits: claves de columna e enteros >= 1, con tope", () => {
  assert.equal(parseLimits(null), undefined);
  assert.deepEqual(parseLimits('{"900101": 60, "otras": 31, "all": 9999}'), { "900101": 60, otras: 31, all: 500 });
  assert.equal(parseLimits('{"x": 1}'), null);
  assert.equal(parseLimits('{"1": 0}'), null);
  assert.equal(parseLimits('{"1": "3"}'), null);
  assert.equal(parseLimits("[1]"), null);
});

test("queryFromFilters ida y vuelta con parseFilters/parseSort", () => {
  const q = queryFromFilters({ q: "ana", estado: "waiting", urgent: true, rango: "today" }, "messages");
  assert.equal(q.toString(), "q=ana&estado=waiting&urgent=1&rango=today&sort=messages");
  assert.deepEqual(parseFilters(q), { q: "ana", estado: "waiting", urgent: true, rango: "today" });
  assert.equal(parseSort(q), "messages");
  assert.equal(queryFromFilters({}, "recent").toString(), "");
});

// ── Paridad con la base (0079) ───────────────────────────────────────────────
test("los valores de estado, rango y orden existen en la migración 0085", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/0085_inbox_paginado.sql", import.meta.url), "utf8");
  const filtro = sql.slice(sql.indexOf("create or replace function inbox_filter_sql"), sql.indexOf("-- ── 6)"));
  for (const e of ESTADOS) assert.match(filtro, new RegExp(`when '${e}'`), `estado ${e}`);
  for (const r of RANGOS) assert.match(filtro, new RegExp(`when '${r}'`), `rango ${r}`);
  for (const s of SORTS) assert.match(sql, new RegExp(`'${s}'`), `orden ${s}`);
  for (const k of ["q", "channel", "vertical", "estado", "urgent", "rango", "etapa"]) assert.match(filtro, new RegExp(`f->>'${k}'`), `filtro ${k}`);
});

// ── Estado ───────────────────────────────────────────────────────────────────
test("normalizeBoard: numeric que llega como string → número", () => {
  const b = normalizeBoard({
    pipeline: 1,
    columns: { "10": { total: 1, rows: [{ ...lead(), max_urgency: "4.5" as unknown as number }], next: null } },
  });
  assert.equal(b.columns["10"].rows[0].max_urgency, 4.5);
});

test("appendPage no repite leads y toma el cursor nuevo", () => {
  const [a, b, c] = [lead(), lead(), lead()];
  const out = appendPage({ rows: [a, b], next: cur(b) } as InboxPage, { rows: [b, c], next: null });
  assert.deepEqual(out.rows.map((r) => r.id), [a.id, b.id, c.id]);
  assert.equal(out.next, null);
});

test("boardLimits: solo columnas con «Ver más» abiertos, con tope", () => {
  const many = Array.from({ length: 45 }, () => lead());
  const board: InboxBoard = {
    pipeline: 1,
    columns: { "10": { total: 90, rows: many, next: cur(many[44]) }, "20": { total: 2, rows: [lead()], next: null } },
  };
  assert.deepEqual(boardLimits(board), { "10": 45 });
  assert.deepEqual(boardLimits(null), {});
});

test("lista: recarga en vivo con lo cargado y sin recortar a quien scrolleó de más", () => {
  assert.equal(listRefreshLimit(null), 50);
  assert.equal(listRefreshLimit({ rows: Array.from({ length: 120 }, () => lead()), next: null }), 120);
  assert.equal(listRefreshLimit({ rows: Array.from({ length: 900 }, () => lead()), next: null }), 500);
  const rows = Array.from({ length: 600 }, () => lead());
  const prev: InboxPage = { rows, next: cur(rows[599]) };
  const nuevo = lead();
  const fresh: InboxPage = { rows: [nuevo, ...rows.slice(0, 499)], next: cur(rows[498]) };
  const merged = mergeRefresh(prev, fresh);
  assert.equal(merged.rows[0].id, nuevo.id);
  assert.equal(new Set(merged.rows.map((r) => r.id)).size, merged.rows.length, "sin repetidos");
  assert.equal(merged.rows.length, 601, "la fila que «se cayó» de la ventana fresca no se pierde");
  assert.deepEqual(merged.next, prev.next);
  // Si lo cargado entra en la recarga, la recarga manda.
  assert.equal(mergeRefresh({ rows: rows.slice(0, 40), next: null }, fresh), fresh);
  // Recarga completa (sin más páginas): manda la recarga aunque antes hubiera más filas.
  const completa: InboxPage = { rows: rows.slice(0, 10), next: null };
  assert.equal(mergeRefresh(prev, completa), completa);
});

test("tablero: una recarga que viajaba durante un «Ver más» no borra las tarjetas cargadas", () => {
  const rows = Array.from({ length: 60 }, () => lead());
  const prev: InboxBoard = { pipeline: 1, columns: { "10": { total: 90, rows, next: cur(rows[59]) } } };
  const fresh: InboxBoard = { pipeline: 1, columns: { "10": { total: 91, rows: rows.slice(0, 30), next: cur(rows[29]) } } };
  const out = mergeBoardRefresh(prev, fresh);
  assert.equal(out.columns["10"].rows.length, 60);
  assert.equal(out.columns["10"].total, 91, "el total es el fresco");
  assert.deepEqual(out.columns["10"].next, prev.columns["10"].next);
  // Otro pipeline: la recarga manda.
  assert.equal(mergeBoardRefresh({ ...prev, pipeline: 2 }, fresh), fresh);
  // Un lead de la cola que la recarga trae en otra columna (lo movieron) no se repite.
  const movido = { ...rows[45], kommo_stage_id: 20 };
  const fresh2: InboxBoard = {
    pipeline: 1,
    columns: { ...fresh.columns, "20": { total: 1, rows: [movido], next: null } },
  };
  const out2 = mergeBoardRefresh(prev, fresh2);
  assert.equal(out2.columns["10"].rows.some((r) => r.id === movido.id), false);
  assert.equal(out2.columns["20"].rows[0].id, movido.id);
});

test("compareLeads: mismo orden que la base (NULL al final, empate por id desc)", () => {
  const a = lead({ last_message_at: "2026-10-01T10:00:00Z" });
  const b = lead({ last_message_at: "2026-10-01T10:00:00Z" });
  const n = lead({ last_message_at: null });
  const sorted = [n, a, b].sort((x, y) => compareLeads("recent", x, y));
  assert.deepEqual(sorted.map((r) => r.id), [b.id, a.id, n.id]);
  assert.deepEqual([b, n, a].sort((x, y) => compareLeads("oldest", x, y)).map((r) => r.id), [n.id, a.id, b.id]);
  const u = lead({ max_urgency: 5, last_message_at: "2020-01-01T00:00:00Z" });
  assert.equal([a, u].sort((x, y) => compareLeads("urgency", x, y))[0].id, u.id);
});

function tablero() {
  const a = lead({ kommo_stage_id: 10, last_message_at: "2026-10-01T12:00:00Z" });
  const b = lead({ kommo_stage_id: 10, last_message_at: "2026-10-01T11:00:00Z" });
  const c = lead({ kommo_stage_id: 20, last_message_at: "2026-10-01T11:30:00Z" });
  const board: InboxBoard = {
    pipeline: 1,
    columns: {
      "10": { total: 2, rows: [a, b], next: null },
      "20": { total: 1, rows: [c], next: null },
      "30": { total: 0, rows: [], next: null },
    },
  };
  return { a, b, c, board };
}

test("moveCard: la tarjeta cambia de columna en su lugar y los totales se ajustan", () => {
  const { a, c, board } = tablero();
  const out = moveCard(board, a.id, { pipeline: 1, stage: 20 }, "recent");
  assert.deepEqual(out.columns["10"].rows.map((r) => r.id).includes(a.id), false);
  assert.equal(out.columns["10"].total, 1);
  assert.deepEqual(out.columns["20"].rows.map((r) => r.id), [a.id, c.id]);
  assert.equal(out.columns["20"].total, 2);
  assert.equal(out.columns["20"].rows[0].kommo_stage_id, 20);
  // El original no se toca (React).
  assert.equal(board.columns["10"].total, 2);
});

test("moveCard: a otro pipeline la tarjeta solo sale; a la misma columna o lead no cargado, nada", () => {
  const { a, board } = tablero();
  const fuera = moveCard(board, a.id, { pipeline: 2, stage: 10 }, "recent");
  assert.equal(fuera.columns["10"].total, 1);
  assert.equal(Object.values(fuera.columns).some((c) => c.rows.some((r) => r.id === a.id)), false);
  assert.equal(moveCard(board, a.id, { pipeline: 1, stage: 10 }, "recent"), board);
  assert.equal(moveCard(board, "nope", { pipeline: 1, stage: 20 }, "recent"), board);
});

test("moveCard: destino con más páginas y la tarjeta cae después de lo cargado → cuenta pero no se muestra", () => {
  const { b, board } = tablero();
  const viejo = lead({ kommo_stage_id: 30, last_message_at: "2026-10-01T11:59:00Z" });
  board.columns["30"] = { total: 50, rows: [viejo], next: cur(viejo) };
  const out = moveCard(board, b.id, { pipeline: 1, stage: 30 }, "recent"); // b es más viejo que «viejo»
  assert.equal(out.columns["30"].total, 51);
  assert.deepEqual(out.columns["30"].rows.map((r) => r.id), [viejo.id]);
});

test("revertMove: vuelve la tarjeta a su columna (visible u oculta en el destino)", () => {
  const { a, board } = tablero();
  const movido = moveCard(board, a.id, { pipeline: 1, stage: 20 }, "recent");
  const vuelto = revertMove(movido, a, { pipeline: 1, stage: 20 }, "recent");
  assert.deepEqual(vuelto.columns["10"].rows.map((r) => r.id), board.columns["10"].rows.map((r) => r.id));
  assert.equal(vuelto.columns["10"].total, 2);
  assert.equal(vuelto.columns["20"].total, 1);
  // Destino con más páginas: la tarjeta quedó oculta (solo contaba); al fallar se repone.
  const viejo = lead({ kommo_stage_id: 30, last_message_at: "2026-10-01T12:30:00Z" });
  const b2: InboxBoard = { ...board, columns: { ...board.columns, "30": { total: 50, rows: [viejo], next: cur(viejo) } } };
  const oculto = moveCard(b2, a.id, { pipeline: 1, stage: 30 }, "recent");
  assert.equal(oculto.columns["30"].rows.some((r) => r.id === a.id), false);
  const repuesto = revertMove(oculto, a, { pipeline: 1, stage: 30 }, "recent");
  assert.equal(repuesto.columns["30"].total, 50);
  assert.equal(repuesto.columns["10"].total, 2);
  assert.equal(repuesto.columns["10"].rows[0].id, a.id);
});

test("applyPendingMoves: una recarga con la etapa vieja respeta el movimiento en curso", () => {
  const { a, board } = tablero();
  const pending = new Map([[a.id, { pipeline: 1, stage: 30 }]]);
  const out = applyPendingMoves(board, pending, "recent");
  assert.deepEqual(out.columns["30"].rows.map((r) => r.id), [a.id]);
  assert.equal(out.columns["30"].total, 1);
  assert.equal(out.columns["10"].total, 1);
  // Si la base ya trae el destino, no se mueve dos veces.
  const yaMovido = moveCard(board, a.id, { pipeline: 1, stage: 30 }, "recent");
  assert.deepEqual(applyPendingMoves(yaMovido, pending, "recent"), yaMovido);
});
