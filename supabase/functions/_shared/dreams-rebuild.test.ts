// _shared/dreams-rebuild.test.ts
// Núcleo de la reconstrucción (rebuildDigestCore) con modelo y Memory Store falsos.
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-rebuild.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
  countRules,
  finalizeArchive,
} from "./dreams-consolidation.ts";
import { type ArchivedText, rebuildDigestCore, type RebuildDeps } from "./dreams-rebuild.ts";
import { renderDigest, SECTION_HEADINGS } from "./dreams-digest-render.ts";
import { DATA_SHAPE_NOTE_PREFIX } from "./dreams-facts.ts";
import { canSkipDigestRebuild, digestFingerprint } from "./dreams-digest-fingerprint.ts";

type D = { id: string; path: string; content: string };
type Alert = { metadata: Record<string, unknown> };

const dream = (i: number, rule = `Regla ${i} sobre la conducta.`, sev = "error"): D => {
  const path = `/dreams/daily/2026-10-${String(i + 1).padStart(3, "0")}_01_${sev === "error" ? "err" : "sug"}_r${i}.md`;
  return { id: `id${i}`, path, content: `---\nseverity: ${sev}\noccurrences: 1\n---\n\n# r${i}\n\n${rule}\n\n**Evidencia:** Lead#1.\n` };
};
const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

/** Archivado falso: una viñeta corta por dream archivado + las viñetas previas. */
function archiver(log: string[] = []) {
  return async (o: { archived: string; dreams: D[]; maxWords: number }, retry?: unknown) => {
    log.push(`archive${retry ? ":retry" : ""}`);
    const prev = o.archived.split("\n").filter((l) => l.startsWith("- "));
    const text = ["## Errores a no repetir", ...prev, ...o.dreams.map((d) => `- Esencia de ${d.id}.`)].join("\n");
    return { value: { text } as ArchivedText, outputRules: countRules(text) };
  };
}

function deps(over: Partial<RebuildDeps<D>> = {}, alerts: Alert[] = [], saved: string[] = [], moved: D[] = []): RebuildDeps<D> {
  return {
    consolidateArchive: archiver(),
    operatorNotes: async () => "- Falta el menú en la KB.",
    stillLatest: async () => true,
    saveArchiveSummary: async (s) => void saved.push(s),
    archiveDream: async (x) => (moved.push(x), true),
    alert: async (row) => void alerts.push(row as Alert),
    ...over,
  };
}

const input = (dreams: D[], over: Partial<Parameters<typeof rebuildDigestCore<D>>[0]> = {}) => ({
  archived: "",
  dreams,
  maxWords: 900,
  maxActive: 60,
  archiveBatch: 50,
  previousNotes: "",
  ...over,
});

Deno.test("sin exceso: el digest es el armado determinístico de los activos; el modelo solo hace las notas", async () => {
  const dreams = Array.from({ length: 20 }, (_, i) => dream(i));
  const log: string[] = [];
  const r = await rebuildDigestCore(input(dreams), deps({ consolidateArchive: archiver(log) }));
  assert(!r.superseded);
  assertEquals(log, [], "no se archiva nada");
  assertEquals(r.digest, renderDigest(dreams, "").text);
  assertEquals(countRules(r.digest), 20, "las 20 reglas, ninguna perdida");
  assertEquals(r.operatorNotes, "- Falta el menú en la KB.");
  assertEquals(r.overCap, false);
});

Deno.test("el operador borra un dream → el siguiente rebuild saca SOLO su viñeta", async () => {
  const dreams = Array.from({ length: 30 }, (_, i) => dream(i));
  dreams[0] = dream(0, "No prometas descuentos.");
  const r1 = await rebuildDigestCore(input(dreams), deps());
  const r2 = await rebuildDigestCore(input(dreams.slice(1)), deps());
  assert(!r1.superseded && !r2.superseded);
  assertStringIncludes(r1.digest, "No prometas descuentos.");
  assert(!r2.digest.includes("No prometas descuentos."), r2.digest);
  assertEquals(countRules(r2.digest), countRules(r1.digest) - 1);
});

Deno.test("tope excedido → archiva los más viejos (modelo falso), guarda el resumen y vuelve a armar dentro del tope", async () => {
  const dreams = Array.from({ length: 12 }, (_, i) => dream(i, `${filler(40, `d${i}w`)}.`));
  const saved: string[] = [];
  const moved: D[] = [];
  const alerts: Alert[] = [];
  const log: string[] = [];
  const r = await rebuildDigestCore(input(dreams, { maxWords: 300 }), deps({ consolidateArchive: archiver(log) }, alerts, saved, moved));
  assert(!r.superseded);
  assertEquals(log, ["archive"]);
  assert(moved.length > 0);
  assertEquals(moved.map((d) => d.id), dreams.slice(0, moved.length).map((d) => d.id), "los más viejos primero");
  assertEquals(saved.length, 1);
  assertEquals(r.archivedSummary, saved[0]);
  assertEquals(r.active.length, 12 - moved.length);
  assert(r.words <= 300, `${r.words} palabras`);
  assertEquals(r.overCap, false);
  // cada activo que quedó y cada esencia archivada aparecen
  for (const d of r.active) assertStringIncludes(r.digest, d.content.split("\n\n")[2]);
  for (const d of moved) assertStringIncludes(r.digest, `- Esencia de ${d.id}.`);
  assertStringIncludes(r.digest, SECTION_HEADINGS.archive);
  assertEquals(alerts.filter((a) => a.metadata.reason === "digest_over_cap").length, 0);
});

Deno.test("resumen archivado demasiado grande → no recorta NADA, guarda completo y alerta digest_over_cap", async () => {
  const dreams = Array.from({ length: 3 }, (_, i) => dream(i));
  const archived = Array.from({ length: 60 }, (_, i) => `- Vieja ${i} ${filler(8, "x")}.`).join("\n");
  const alerts: Alert[] = [];
  const log: string[] = [];
  const r = await rebuildDigestCore(input(dreams, { archived, maxWords: 300 }), deps({ consolidateArchive: archiver(log) }, alerts));
  assert(!r.superseded);
  assertEquals(log, [], "archivar no lo arregla: no se llama al modelo");
  assertEquals(r.overCap, true);
  assertEquals(countRules(r.digest), 63, "todas las reglas, ninguna recortada");
  const over = alerts.filter((a) => a.metadata.reason === "digest_over_cap");
  assertEquals(over.length, 1);
  assertEquals(over[0].metadata.words, r.words);
});

Deno.test("las notas del operador fallan → quedan las anteriores (sin las de datos viejas) y el digest no cambia", async () => {
  const dreams = [dream(0), dream(1, "Para reclamos da ventas@x.com.")];
  const previousNotes = `- ${DATA_SHAPE_NOTE_PREFIX} un dato viejo ya corregido.\n- Falta el horario del domingo en la KB.`;
  const ok = await rebuildDigestCore(input(dreams, { previousNotes }), deps());
  const failed = await rebuildDigestCore(
    input(dreams, { previousNotes }),
    deps({ operatorNotes: () => Promise.reject(new Error("refusal")) }),
  );
  assert(!ok.superseded && !failed.superseded);
  assertEquals(failed.digest, ok.digest, "las notas nunca tocan el digest");
  assertEquals(failed.notesFailed, true);
  assertEquals(ok.notesFailed, false);
  const lines = failed.operatorNotes.split("\n");
  assertEquals(lines.length, 2, failed.operatorNotes);
  assert(lines[0].startsWith(`- ${DATA_SHAPE_NOTE_PREFIX} `) && lines[0].endsWith("Para reclamos da ventas@x.com."), lines[0]);
  assertStringIncludes(lines[0], "quedó vacío tras quitar datos");
  assertEquals(lines[1], "- Falta el horario del domingo en la KB.");
});

Deno.test("una regla con dato de alto riesgo: fuera del digest, a las notas, UNA alerta de datos por rebuild", async () => {
  const dreams = [dream(0), dream(1, "Para reclamos da ventas@x.com."), dream(2, "El combo cuesta $25.")];
  const alerts: Alert[] = [];
  const r = await rebuildDigestCore(input(dreams), deps({}, alerts));
  assert(!r.superseded);
  assert(!r.digest.includes("ventas@x.com") && !r.digest.includes("$25"), r.digest);
  assertStringIncludes(r.operatorNotes, DATA_SHAPE_NOTE_PREFIX);
  assertStringIncludes(r.operatorNotes, "El combo cuesta $25.");
  const shape = alerts.filter((a) => a.metadata.reason === "consolidation_data_shape");
  assertEquals(shape.length, 1);
  assertEquals(shape[0].metadata.digest_count, 2);
});

Deno.test("el archivado con dato de alto riesgo: esa viñeta sale del resumen y va a las notas", async () => {
  const dreams = Array.from({ length: 4 }, (_, i) => dream(i));
  const alerts: Alert[] = [];
  const consolidateArchive = async () => {
    const a = finalizeArchive("- Regla vieja.\n- Paga en https://pago.x.com/ya.", 900);
    return { value: { text: a.text, dataShapeRemoved: a.dataShapeRemoved }, outputRules: a.outputRules, dataRemovedRules: a.dataRemovedRules };
  };
  const r = await rebuildDigestCore(input(dreams, { maxActive: 3 }), deps({ consolidateArchive }, alerts));
  assert(!r.superseded);
  assert(!r.digest.includes("https://"), r.digest);
  assertStringIncludes(r.operatorNotes, `${DATA_SHAPE_NOTE_PREFIX} Paga en https://pago.x.com/ya.`);
  assertEquals(alerts.filter((a) => a.metadata.reason === "consolidation_data_shape")[0].metadata.archive_count, 1);
});

Deno.test("archivado con pérdida → se guarda igual (nunca se congela), alerta y el digest se arma", async () => {
  const dreams = Array.from({ length: 70 }, (_, i) => dream(i));
  const alerts: Alert[] = [];
  const log: string[] = [];
  const lossy = async (o: { dreams: D[] }, retry?: unknown) => {
    log.push(`archive${retry ? ":retry" : ""}`);
    const text = o.dreams.filter((_, i) => i % 2 === 0).map((d) => `- Esencia de ${d.id}.`).join("\n");
    return { value: { text } as ArchivedText, outputRules: countRules(text) };
  };
  const r = await rebuildDigestCore(input(dreams), deps({ consolidateArchive: lossy }, alerts));
  assert(!r.superseded);
  assertEquals(log, ["archive", "archive:retry"]);
  assertEquals(r.archivedCount, 10);
  assertEquals(r.active.length, 60);
  assert(r.archiveLoss);
  assertEquals(alerts.filter((a) => a.metadata.reason === "consolidation_loss").length, 1);
});

for (const [nombre, falla] of [
  ["sin viñetas", async () => ({ value: { text: "texto suelto" } as ArchivedText, outputRules: 0 })],
  ["refusal", () => Promise.reject(new Error("refusal"))],
  ["red", () => Promise.reject(new TypeError("fetch failed"))],
] as const) {
  Deno.test(`archivado falla (${nombre}) → no lanza: alerta archive_failed, digest con TODOS los activos, sin mover nada`, async () => {
    const dreams = Array.from({ length: 70 }, (_, i) => dream(i));
    const alerts: Alert[] = [];
    const saved: string[] = [];
    const moved: D[] = [];
    const r = await rebuildDigestCore(input(dreams), deps({ consolidateArchive: falla }, alerts, saved, moved));
    assert(!r.superseded);
    assertEquals(r.archiveFailed, true, "el llamador NO guarda el fingerprint: la próxima corrida reintenta archivar");
    assertEquals(saved.length, 0, "el resumen archivado vivo no se toca");
    assertEquals(moved.length, 0);
    assertEquals(r.archivedCount, 0);
    assertEquals(r.active.length, 70);
    assertEquals(r.digest, renderDigest(dreams, "").text, "todos los activos, sin modelo");
    assertEquals(countRules(r.digest), 70);
    const failed = alerts.filter((a) => a.metadata.reason === "archive_failed");
    assertEquals(failed.length, 1);
    assertEquals(failed[0].metadata.pending, 10);
    if (nombre === "sin viñetas") assertEquals(failed[0].metadata.malformed, true);
  });
}

Deno.test("archivado falla y el digest pasa el tope → se guarda completo y alerta digest_over_cap", async () => {
  const dreams = Array.from({ length: 30 }, (_, i) => dream(i, `Regla ${i} ${filler(20, "w")}.`));
  const alerts: Alert[] = [];
  const r = await rebuildDigestCore(
    input(dreams, { maxWords: 300 }),
    deps({ consolidateArchive: () => Promise.reject(new Error("refusal")) }, alerts),
  );
  assert(!r.superseded);
  assertEquals(r.archiveFailed, true);
  assertEquals(r.overCap, true);
  assertEquals(countRules(r.digest), 30);
  assertEquals(alerts.map((a) => a.metadata.reason).sort(), ["archive_failed", "digest_over_cap"]);
});

Deno.test("archivado falla: borrar un dream igual lo saca del digest en esa misma reconstrucción", async () => {
  const dreams = Array.from({ length: 70 }, (_, i) => dream(i));
  const sinUno = dreams.filter((_, i) => i !== 65);
  const r = await rebuildDigestCore(input(sinUno), deps({ consolidateArchive: () => Promise.reject(new Error("refusal")) }));
  assert(!r.superseded);
  assert(!r.digest.includes("Regla 65 "), "el dream borrado no está");
  assertStringIncludes(r.digest, "Regla 64 ");
  assertEquals(countRules(r.digest), 69);
});

Deno.test("archivado OK → archiveFailed false", async () => {
  const r = await rebuildDigestCore(input(Array.from({ length: 70 }, (_, i) => dream(i))), deps());
  assert(!r.superseded);
  assertEquals(r.archiveFailed, false);
});

Deno.test("una reconstrucción más nueva gana: no devuelve digest ni guarda el resumen", async () => {
  const dreams = Array.from({ length: 70 }, (_, i) => dream(i));
  const saved: string[] = [];
  const r = await rebuildDigestCore(input(dreams), deps({ stillLatest: async () => false }, [], saved));
  assertEquals(r, { superseded: true, archivedCount: 0 });
  assertEquals(saved.length, 0);
});

Deno.test("si la alerta falla, la reconstrucción sigue", async () => {
  const dreams = [dream(0, "Da ventas@x.com.")];
  const r = await rebuildDigestCore(input(dreams), deps({ alert: () => Promise.reject(new Error("base caída")) }));
  assert(!r.superseded);
});

Deno.test("fingerprint: sin cambios se omite; borrar un dream o subir la versión del armado reconstruye", async () => {
  const dreams = Array.from({ length: 5 }, (_, i) => dream(i));
  const ctx = { model: "m", renderVersion: "render-1", maxWords: 900, operator: "Acme", archived: "" };
  const r = await rebuildDigestCore(input(dreams), deps());
  assert(!r.superseded);
  const stored = await digestFingerprint(r.active, r.digest, ctx);
  const same = await digestFingerprint(dreams, r.digest, ctx);
  assertEquals(canSkipDigestRebuild({ stored, current: same, pendingArchive: 0 }), true);
  assertEquals(canSkipDigestRebuild({ stored, current: await digestFingerprint(dreams.slice(1), r.digest, ctx), pendingArchive: 0 }), false);
  assertEquals(canSkipDigestRebuild({ stored, current: await digestFingerprint(dreams, r.digest, { ...ctx, renderVersion: "render-2" }), pendingArchive: 0 }), false);
});

Deno.test("«Para el operador: …» de un dream va a las notas (sin alerta de datos) y no se duplica si el modelo falla", async () => {
  const dreams = [dream(0, "Usa solo lo aprobado del system prompt. Para el operador: falta cargar la información oficial de Cashea en la KB.")];
  const alerts: Alert[] = [];
  const r = await rebuildDigestCore(input(dreams), deps({}, alerts));
  assert(!r.superseded);
  assert(!/para el operador/i.test(r.digest), r.digest);
  assertStringIncludes(r.digest, "- Usa solo lo aprobado del system prompt.");
  assertStringIncludes(r.operatorNotes, "falta cargar la información oficial de Cashea en la KB.");
  assertEquals(alerts.filter((a) => a.metadata.reason === "consolidation_data_shape").length, 0);
  const failed = await rebuildDigestCore(
    input(dreams, { previousNotes: r.operatorNotes }),
    deps({ operatorNotes: () => Promise.reject(new Error("refusal")) }),
  );
  assert(!failed.superseded);
  assertEquals(failed.operatorNotes.split("\n").filter((l) => l.includes("Cashea")).length, 1, failed.operatorNotes);
});

Deno.test("las notas del render viajan al modelo como «ya registradas» y su versión reformulada no se duplica", async () => {
  const dreams = [dream(0, "Usa solo lo aprobado. Para el operador: falta cargar la información oficial de Cashea en la KB.")];
  let known: string[] = [];
  const r = await rebuildDigestCore(
    input(dreams),
    deps({
      operatorNotes: async (o) => {
        known = o.known;
        return "- Falta cargar la información oficial de Cashea en la KB.\n- Falta el menú en la KB.";
      },
    }),
  );
  assert(!r.superseded);
  assertEquals(known.length, 1);
  assertStringIncludes(known[0], "Cashea");
  assertEquals(r.operatorNotes.split("\n").filter((l) => l.includes("Cashea")).length, 1, r.operatorNotes);
  assertStringIncludes(r.operatorNotes, "- Falta el menú en la KB.");
});

Deno.test("si el modelo falla, las notas anteriores se fusionan con las del render sin duplicar", async () => {
  const dreams = [dream(0, "Usa solo lo aprobado. Para el operador: falta cargar la información oficial de Cashea en la KB.")];
  const previousNotes = "- Falta cargar la información oficial de Cashea en la KB.\n- Falta el horario del domingo en la KB.";
  const r = await rebuildDigestCore(
    input(dreams, { previousNotes }),
    deps({ operatorNotes: () => Promise.reject(new Error("refusal")) }),
  );
  assert(!r.superseded);
  assertEquals(r.notesFailed, true);
  assertEquals(r.operatorNotes.split("\n").length, 2, r.operatorNotes);
  assertStringIncludes(r.operatorNotes, "horario del domingo");
});
