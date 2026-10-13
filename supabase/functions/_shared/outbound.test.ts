// _shared/outbound.test.ts
// 1) Comportamiento de writeClientText / draftText.
// 2) PARIDAD: fallan si aparece un camino de salida de texto al cliente que no
//    pase por el verificador. Leen el código fuente de las Edge Functions.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { draftText, OutboundBlockedError, outboundLeak, writeClientText } from "./outbound.ts";

function withFetchMock<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const base = { kommoLeadId: 1, fieldId: 2, kommoDomain: "x.kommo.com", kommoToken: "t" };

Deno.test("draftText: gana el texto editado a mano; sin edición, el del agente", () => {
  assertEquals(draftText({ body: "agente", edited_body: "  editado  " }), "editado");
  assertEquals(draftText({ body: "agente", edited_body: "   " }), "agente");
  assertEquals(draftText({ body: "agente", edited_body: null }), "agente");
  assertEquals(draftText({ body: "agente" }), "agente");
});

Deno.test("outboundLeak: vacío y residuo interno se bloquean; un mensaje normal pasa", () => {
  assertEquals(outboundLeak("  "), "texto vacío");
  assert(outboundLeak('<parameter name="respuesta">hola') !== null);
  assert(outboundLeak("Revisé /mnt/memory/leads/123/learnings.md") !== null);
  assertEquals(outboundLeak("¡Hola! Tu función es hoy a las 7:00 pm."), null);
});

Deno.test("writeClientText: con fuga NO toca la API de Kommo", async () => {
  let llamadas = 0;
  await withFetchMock(
    () => {
      llamadas++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    async () => {
      const e = await assertRejects(
        () => writeClientText({ ...base, kind: "public_reply", text: "uso search_kb para buscar" }),
        OutboundBlockedError,
      );
      assertEquals(e.kind, "public_reply");
    },
  );
  assertEquals(llamadas, 0);
});

Deno.test("writeClientText: texto limpio se escribe en el campo", async () => {
  const bodies: string[] = [];
  await withFetchMock(
    (_u, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    () => writeClientText({ ...base, kind: "dm", text: "Hola, te confirmo la función." }),
  );
  assertEquals(bodies.length, 1);
  assert(bodies[0].includes("Hola, te confirmo la función."));
});

// ---------------------------------------------------------------------------
// PARIDAD de caminos de salida
// ---------------------------------------------------------------------------
const FN_DIR = new URL("../", import.meta.url);

async function sources(): Promise<Array<{ path: string; src: string }>> {
  const out: Array<{ path: string; src: string }> = [];
  for await (const d of Deno.readDir(FN_DIR)) {
    if (!d.isDirectory || d.name === "_shared") continue;
    const path = `${d.name}/index.ts`;
    try {
      out.push({ path, src: await Deno.readTextFile(new URL(path, FN_DIR)) });
    } catch {
      // función sin index.ts
    }
  }
  return out;
}

// Quita comentarios y strings de línea para no contar menciones en prosa.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("PARIDAD: ninguna Edge Function llama a patchLeadField (solo _shared/outbound.ts)", async () => {
  for (const { path, src } of await sources()) {
    const llamadas = code(src).split(/\bpatchLeadField\s*\(/).length - 1;
    assertEquals(llamadas, 0, `${path} llama a patchLeadField directo: usar writeClientText (_shared/outbound.ts)`);
  }
});

Deno.test("PARIDAD: toda función que dispara un salesbot escribe el texto con writeClientText", async () => {
  const conSalesbot = (await sources()).filter(({ src }) => /\brunSalesbot\s*\(/.test(code(src)));
  assert(conSalesbot.length > 0, "se esperaba al menos un llamador de runSalesbot");
  for (const { path, src } of conSalesbot) {
    assert(/\bwriteClientText\s*\(/.test(code(src)), `${path} dispara un salesbot sin pasar el texto por writeClientText`);
  }
});

Deno.test("PARIDAD: publish-to-kommo publica el texto editado y verifica cada canal", async () => {
  const src = code(await Deno.readTextFile(new URL("publish-to-kommo/index.ts", FN_DIR)));
  assert(/\bdraftText\s*\(/.test(src), "publish-to-kommo debe publicar draftText (edited_body ?? body)");
  assert(/kind:\s*"dm"/.test(src) && /kind:\s*"public_reply"/.test(src), "DM y respuesta pública pasan por writeClientText");
  assert(/OutboundBlockedError/.test(src), "publish-to-kommo debe tratar OutboundBlockedError");
});

Deno.test("PARIDAD: follow-up-scan verifica las variables que salen al cliente", async () => {
  const src = code(await Deno.readTextFile(new URL("follow-up-scan/index.ts", FN_DIR)));
  assert(/kind:\s*"follow_up"/.test(src) && /OutboundBlockedError/.test(src));
});

Deno.test("PARIDAD: generate-response verifica la respuesta pública al generarla", async () => {
  const src = code(await Deno.readTextFile(new URL("generate-response/index.ts", FN_DIR)));
  assert(/\boutboundLeak\s*\(\s*rawReply|\boutboundLeak\s*\(\s*publicReply/.test(src), "la public_reply generada debe pasar por outboundLeak");
});
