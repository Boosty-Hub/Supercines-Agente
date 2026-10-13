// _shared/webhook-secret-leak.test.ts
// Guardia: el secreto del webhook de Kommo (?token= en el destino) no puede terminar en la
// base (alerts / system_incidents, legibles por cualquier usuario con sesión), en logs
// propios (console.*) ni en respuestas HTTP. La ÚNICA salida permitida es la URL completa
// del panel (GET/rotate de /api/kommo/webhook-auth, alcance `configuracion`) y el body que
// se le manda a Kommo para registrarlo.
//
// Correr con: deno test --allow-read supabase/functions/_shared/webhook-secret-leak.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { decidirWebhookKommo } from "./health-detectores.ts";
import { maskDestination } from "./webhook-mask.ts";

const SECRET = "f00dfeedc0ffee1234567890abcdef1234567890abcdef12";
const PATH = "/functions/v1/kommo-webhook";

Deno.test("health-scan: el incidente de webhook deshabilitado NO guarda el secreto", () => {
  const inc = decidirWebhookKommo([{ destination: `https://x.supabase.co${PATH}?token=${SECRET}`, disabled: true }], PATH);
  assert(inc);
  const dump = JSON.stringify(inc);
  assert(!dump.includes(SECRET), dump);
  assertEquals(inc.metadata?.destination, `https://x.supabase.co${PATH}?token=***`);
});

Deno.test("maskDestination: URL, ?secret= legado y texto libre (error de Kommo)", () => {
  assertEquals(maskDestination(`https://x${PATH}?token=${SECRET}&a=1`), `https://x${PATH}?token=***&a=1`);
  assertEquals(maskDestination(`https://x${PATH}?secret=${SECRET}`), `https://x${PATH}?secret=***`);
  const err = `{"detail":"destination https://x${PATH}?token=${SECRET} is invalid"}`;
  assert(!maskDestination(err).includes(SECRET));
  assert(maskDestination(err).includes(" is invalid"));
});

// ---- Barrido estático de supabase/functions y web/src ----
const ROOT = new URL("../../../", import.meta.url);
const DIRS = ["supabase/functions", "web/src"];

async function* walk(dir: URL, rel: string): AsyncGenerator<{ rel: string; url: URL }> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    const r = `${rel}/${e.name}`;
    if (e.isDirectory) yield* walk(u, r);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.generated\.ts$/.test(e.name)) {
      yield { rel: r, url: u };
    }
  }
}

/**
 * Líneas que sacan un destino/URL del webhook hacia afuera. Cada una debe pasar por
 * maskDestination o estar en la lista de salidas permitidas.
 */
const SINKS: Array<{ name: string; re: RegExp }> = [
  // un log propio con el destino o la URL de la request (que trae ?token=)
  { name: "console", re: /console\.\w+\(.*(destination|webhookDestination|req(uest)?\.url)/ },
  // un objeto (metadata de alerta/incidente, respuesta JSON) que copia el destino de un hook
  { name: "objeto", re: /\b\w+\s*:\s*[^=]*[\w\])]\??\.destination\b(?!\s*(===|!==|==|!=))/ },
  // una respuesta HTTP que devuelve un destino
  { name: "respuesta", re: /(NextResponse\.json|new Response)\(.*\bdestination\b/ },
];

/** Salidas permitidas: archivo → fragmentos de línea (con su motivo). */
const ALLOWED: Record<string, string[]> = {
  // registrar el destino en Kommo es justamente mandarle la URL con el secreto
  "web/src/lib/kommo-webhook-apply.ts": ["body: JSON.stringify({ destination, settings"],
};

Deno.test("el barrido detecta las fugas conocidas (el regex no quedó ciego)", () => {
  const leaks = [
    "destination: deshabilitados[0]?.destination ?? null,", // health-detectores antes del fix
    "return NextResponse.json({ ok: true, destination, settings });", // reconnect-webhook antes del fix
    "console.warn(`no se pudo dar de baja ${old.destination}`);",
    "console.log('req', req.url);",
    "metadata: { url: hook.destination },",
  ];
  for (const l of leaks) assert(SINKS.some((s) => s.re.test(l)), l);
  const ok = ["if (h.destination === destination) return;", "destination?: string | null;", "ours.map((h) => h.destination)"];
  for (const l of ok) assert(!SINKS.some((s) => s.re.test(l)), l);
});

Deno.test("ningún log, objeto persistido ni respuesta saca el destino del webhook sin enmascarar", async () => {
  const bad: string[] = [];
  let files = 0;
  for (const d of DIRS) {
    for await (const f of walk(new URL(d + "/", ROOT), d)) {
      files++;
      const lines = (await Deno.readTextFile(f.url)).split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (t.includes("maskDestination(")) return;
        if ((ALLOWED[f.rel] ?? []).some((frag) => t.includes(frag))) return;
        for (const s of SINKS) if (s.re.test(t)) bad.push(`${f.rel}:${i + 1} [${s.name}] ${t}`);
      });
    }
  }
  assert(files > 100, `solo ${files} archivos: el barrido dejó de ver el código`);
  assertEquals(bad, []);
});
