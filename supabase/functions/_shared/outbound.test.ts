// _shared/outbound.test.ts
// Tests del verificador único de texto saliente y de PARIDAD: si aparece un camino
// de salida de texto hacia Kommo que no pase por _shared/outbound.ts, o un consumidor
// de «lo enviado» que no use draftText, estos tests fallan.
//
// Correr con: deno test --allow-read --allow-env supabase/functions/_shared/outbound.test.ts

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { draftText, OutboundBlockedError, outboundLeak, writeClientText, writeCrmField } from "./outbound.ts";

const LEAK = 'Claro <parameter name="respuesta">te ayudo</parameter>';

// ---- draftText: lo que realmente se envía ----

Deno.test("draftText: el texto editado a mano (edited_body) gana sobre el del agente", () => {
  assertEquals(draftText({ body: "borrador del agente", edited_body: "  corregido por el operador  " }), "corregido por el operador");
});

Deno.test("draftText: sin edición (null, undefined, vacío o solo espacios) se envía el del agente", () => {
  assertEquals(draftText({ body: "del agente", edited_body: null }), "del agente");
  assertEquals(draftText({ body: "del agente" }), "del agente");
  assertEquals(draftText({ body: "del agente", edited_body: "" }), "del agente");
  assertEquals(draftText({ body: "del agente", edited_body: "   " }), "del agente");
});

// ---- el verificador ----

Deno.test("outboundLeak: vacío y residuo interno se rechazan; texto limpio pasa", () => {
  assertEquals(outboundLeak(""), "texto vacío");
  assertEquals(outboundLeak("   "), "texto vacío");
  assertEquals(outboundLeak(null), "texto vacío");
  assert(outboundLeak(LEAK) !== null);
  assertEquals(outboundLeak("Hola Ana, te paso el detalle por aquí 😊"), null);
});

// fetch simulado: registra las llamadas a Kommo
function withFetchMock<T>(run: (calls: Array<{ url: string; method: string; body: string }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const base = { kommoLeadId: 1, fieldId: 2, kommoDomain: "x.kommo.com", kommoToken: "t" };

Deno.test("writeClientText: con residuo interno lanza y NO toca Kommo (DM, pública y seguimiento)", async () => {
  await withFetchMock(async (calls) => {
    for (const kind of ["dm", "public_reply", "follow_up"] as const) {
      const err = await assertRejects(() => writeClientText({ ...base, kind, text: LEAK }), OutboundBlockedError);
      assertEquals((err as OutboundBlockedError).kind, kind);
    }
    assertEquals(calls.length, 0);
  });
});

Deno.test("writeClientText: texto limpio escribe el campo", async () => {
  await withFetchMock(async (calls) => {
    await writeClientText({ ...base, kind: "dm", text: "Hola, ¿cómo estás?" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "PATCH");
    assertEquals(calls[0].body.includes("Hola"), true);
  });
});

Deno.test("writeCrmField: el valor que eligió el modelo también se verifica (lead y contacto); vacío es legítimo", async () => {
  await withFetchMock(async (calls) => {
    for (const entity of ["lead", "contact"] as const) {
      await assertRejects(
        () => writeCrmField({ entity, entityId: 1, fieldId: 2, value: LEAK, kommoDomain: "x", kommoToken: "t" }),
        OutboundBlockedError,
      );
    }
    assertEquals(calls.length, 0);
    await writeCrmField({ entity: "lead", entityId: 1, fieldId: 2, value: "", kommoDomain: "x", kommoToken: "t" });
    assertEquals(calls.length, 1);
  });
});

// ---- PARIDAD ESTRUCTURAL ----

const SHARED_OK = new Set(["outbound.ts", "kommo.ts"]); // outbound.ts es el camino; kommo.ts define las primitivas
const sinComentarios = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

async function archivosFuente(): Promise<Array<{ name: string; code: string }>> {
  const out: Array<{ name: string; code: string }> = [];
  const root = new URL("../", import.meta.url);
  for await (const dir of Deno.readDir(root)) {
    if (!dir.isDirectory) continue;
    if (dir.name === "_shared") {
      for await (const f of Deno.readDir(new URL("../_shared/", import.meta.url))) {
        if (f.isFile && f.name.endsWith(".ts") && !f.name.endsWith(".test.ts") && !SHARED_OK.has(f.name)) {
          out.push({ name: `_shared/${f.name}`, code: sinComentarios(await Deno.readTextFile(new URL(`../_shared/${f.name}`, import.meta.url))) });
        }
      }
    } else {
      out.push({ name: `${dir.name}/index.ts`, code: sinComentarios(await Deno.readTextFile(new URL(`../${dir.name}/index.ts`, import.meta.url))) });
    }
  }
  return out;
}

Deno.test("PARIDAD: ningún camino escribe texto a Kommo sin pasar por outbound.ts (patchLeadField/patchContactField)", async () => {
  for (const f of await archivosFuente()) {
    assert(!/\bpatch(Lead|Contact)Field\s*\(/.test(f.code), `${f.name}: llama a patchLeadField/patchContactField directo (usar writeClientText o writeCrmField de _shared/outbound.ts)`);
  }
});

Deno.test("PARIDAD: quien dispara un salesbot de texto al cliente verifica antes con writeClientText", async () => {
  for (const f of await archivosFuente()) {
    if (/\brunSalesbot\s*\(/.test(f.code)) {
      assert(/\bwriteClientText\s*\(/.test(f.code), `${f.name}: dispara runSalesbot sin writeClientText`);
    }
  }
});

Deno.test("PARIDAD: publish-to-kommo / follow-up-scan / generate-response verifican cada canal que sacan", async () => {
  const por = Object.fromEntries((await archivosFuente()).map((f) => [f.name, f.code]));
  const pub = por["publish-to-kommo/index.ts"];
  assert(/kind:\s*"dm"/.test(pub), "publish-to-kommo: el DM no pasa por writeClientText");
  assert(/kind:\s*"public_reply"/.test(pub), "publish-to-kommo: la respuesta pública no pasa por writeClientText");
  assert(/draftText\(/.test(pub), "publish-to-kommo: no usa draftText (publicaría draft.body ignorando la edición)");
  assert(!/\bd(raft)?\.body\b/.test(pub), "publish-to-kommo: usa draft.body / d.body directo (la edición humana nunca saldría)");
  assert(/edited_body/.test(pub), "publish-to-kommo: el select no trae edited_body");
  assert(/kind:\s*"follow_up"/.test(por["follow-up-scan/index.ts"]), "follow-up-scan: las variables no pasan por writeClientText");
  const gen = por["generate-response/index.ts"];
  assert(/outboundLeak\(publicReply\)/.test(gen), "generate-response: la respuesta pública no se verifica al generarla");
  // SuperCines: generate-response escribe los campos select/enum con su propio
  // escritor tipado (writeEntityField → patchEntityFieldTyped, resuelve el enum_id de
  // Kommo), así que el verificador entra por crmValueLeak ANTES de escribir.
  assert(/crmValueLeak\(value\)/.test(gen), "generate-response: las tools de CRM no verifican el valor con crmValueLeak");
  assert(
    gen.indexOf("crmValueLeak(value)") < gen.indexOf("patchEntityFieldTyped(entity"),
    "generate-response: patchEntityFieldTyped se llama antes de verificar el valor",
  );
});

Deno.test("PARIDAD: los consumidores de «lo enviado» usan draftText, no edited_body ?? body ni body a secas", async () => {
  const por = Object.fromEntries((await archivosFuente()).map((f) => [f.name, f.code]));
  for (const f of ["dreams-run/index.ts", "evaluate-outcomes/index.ts", "_shared/history.ts"]) {
    assert(/\bdraftText\(/.test(por[f]), `${f}: no usa draftText`);
    assert(!/edited_body\s*\?\?/.test(por[f]), `${f}: usa edited_body ?? … (un edited_body vacío devolvería vacío): usar draftText`);
  }
});

Deno.test("PARIDAD: la copia web de draftText es idéntica a la de las Edge Functions", async () => {
  const fn = (s: string) => s.slice(s.indexOf("export function draftText")).replace(/\s+/g, " ").trim();
  const edge = await Deno.readTextFile(new URL("./draft-text.ts", import.meta.url));
  const web = await Deno.readTextFile(new URL("../../../web/src/lib/draft-text.ts", import.meta.url));
  assertEquals(fn(web), fn(edge));
});

// ---- stripGuardFlags: el motivo del bloqueo de la respuesta publica se conserva ----
import { stripGuardFlags } from "./outbound.ts";

Deno.test("stripGuardFlags: un bloqueo anterior del DM se descarta para que el guard decida de nuevo", () => {
  const meta = { guard_blocked: true, guard_kind: "internal_leak", guard_reason: "x", guard_stage: "publish", otro: 1 };
  assertEquals(stripGuardFlags(meta), { otro: 1 });
});

Deno.test("stripGuardFlags: el bloqueo de la respuesta PUBLICA conserva su motivo para el inbox", () => {
  const meta = {
    public_reply_blocked: true, guard_blocked: true, guard_kind: "internal_leak", guard_part: "public_reply",
    guard_reason: "sintaxis de tool", guard_stage: "generate", otro: 1,
  };
  assertEquals(stripGuardFlags(meta), meta);
  // es una copia: no muta el original
  assert(stripGuardFlags(meta) !== meta);
});
