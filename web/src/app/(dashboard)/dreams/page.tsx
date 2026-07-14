import { listDreams, listPendingDreams, readDream, parseFrontmatter } from "@/lib/memory-list";
import { configValue } from "@/lib/runtime-config";
import { PageShell, EmptyState, Stars } from "@/components/ui";
import RunButton from "./run-button";
import DeleteDreamButton from "./delete-button";
import ExportImportButtons from "./export-import";
import PendingDreamActions from "./pending-actions";
import PolicySelector from "./policy-selector";
import FrequencySelector from "./frequency-selector";

export const dynamic = "force-dynamic";

type SearchParams = { open?: string };

const categoryColor: Record<string, string> = {
  objection_pattern: "bg-blue-100 text-blue-700",
  voice_rule: "bg-purple-100 text-purple-700",
  factual_gap: "bg-amber-100 text-amber-800",
  successful_phrasing: "bg-emerald-100 text-emerald-700",
  anti_pattern: "bg-red-100 text-red-700",
};

// Severidad codificada en el filename (sug|adv|err) por dreams-run.
const SEVERITY: Record<string, { label: string; cls: string }> = {
  sug: { label: "sugerencia", cls: "bg-emerald-100 text-emerald-700" },
  adv: { label: "advertencia", cls: "bg-amber-100 text-amber-800" },
  err: { label: "error", cls: "bg-red-100 text-red-700" },
};

const severityColor: Record<string, string> = {
  sugerencia: "bg-emerald-100 text-emerald-700",
  advertencia: "bg-amber-100 text-amber-800",
  error: "bg-red-100 text-red-700",
};

type ParsedDream = {
  id: string;
  path: string;
  title: string;
  date: string;
  period: string;
  sev: string | null;
};

// /dreams[-pending]/daily/2026-06-10_00_err_titulo.md — el token de severidad
// es opcional para compatibilidad con dreams viejos sin él.
function parseDreamPath(id: string, path: string): ParsedDream {
  const m = path.match(
    /^\/dreams(?:-pending)?\/([^/]+)\/(\d{4}-\d{2}-\d{2})_\d+_(?:(sug|adv|err)_)?(.+)\.md$/
  );
  return {
    id,
    path,
    period: m?.[1] ?? "",
    date: m?.[2] ?? "",
    sev: m?.[3] ?? null,
    title: (m?.[4] ?? path).replace(/_/g, " "),
  };
}

// Frontmatter `leads: Lead#3=<uuid>; Lead#7=<uuid>` → mapa para linkear la
// evidencia ("Lead#3") directo a la conversación real en el inbox.
function parseLeadRefs(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (meta.leads ?? "").split(";")) {
    const m = pair.trim().match(/^(Lead#\d+)=([0-9a-f-]{36})$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Renderiza el cuerpo del dream convirtiendo cada "Lead#N" conocido en un
// link a su conversación.
function BodyWithLeadLinks({ body, leadRefs }: { body: string; leadRefs: Record<string, string> }) {
  const parts = body.split(/(Lead#\d+)/g);
  return (
    <pre className="whitespace-pre-wrap font-sans text-sm text-neutral-600">
      {parts.map((p, i) =>
        leadRefs[p] ? (
          <a
            key={i}
            href={`/inbox?lead=${leadRefs[p]}`}
            className="font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-800"
            title="Ver la conversación de este lead"
          >
            {p}
          </a>
        ) : (
          p
        )
      )}
    </pre>
  );
}

export default async function DreamsPage({ searchParams }: { searchParams: SearchParams }) {
  let items: Awaited<ReturnType<typeof listDreams>> = [];
  let pendingItems: Awaited<ReturnType<typeof listPendingDreams>> = [];
  let listError: string | null = null;
  try {
    [items, pendingItems] = await Promise.all([listDreams(), listPendingDreams()]);
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }

  const policy = (await configValue("DREAMS_AUTO_ACTIVATE")) || "all";
  const frequency = (await configValue("DREAMS_FREQUENCY")) || "daily";

  const parsedItems = items.map((it) => parseDreamPath(it.id, it.path));
  const parsedPending = pendingItems.map((it) => parseDreamPath(it.id, it.path));

  // Para los items abiertos, leemos el contenido
  let openContent: { meta: Record<string, string>; body: string; path: string } | null = null;
  if (searchParams.open) {
    const dream = await readDream(searchParams.open);
    if (dream) {
      const parsed = parseFrontmatter(dream.content);
      openContent = { meta: parsed.meta, body: parsed.body, path: dream.path };
    }
  }

  return (
    <PageShell
      title="Dreams"
      description="Aprendizajes destilados de conversaciones. El análisis corre según la frecuencia elegida (el cron pasa a diario 3 AM UTC y respeta esa frecuencia)."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* Acciones primarias: Run */}
          <RunButton />
          {/* Acciones secundarias plegables */}
          <details className="relative">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50 select-none">
              ⋯ Más
            </summary>
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[12rem] rounded-xl border border-neutral-200 bg-white p-2 shadow-pop">
              <ExportImportButtons />
            </div>
          </details>
          <FrequencySelector initial={frequency} />
          <PolicySelector initial={policy} />
        </div>
      }
    >
      {listError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="font-semibold">No pudimos cargar los aprendizajes.</p>
          <p className="mt-0.5">Reintentá en unos segundos.{" "}
            <a href="/dreams" className="font-medium underline hover:text-red-800">
              Actualizar
            </a>
          </p>
        </div>
      )}

      {/* Modal de detalle */}
      {openContent && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
          <a
            href="/dreams"
            aria-label="Cerrar"
            className="absolute inset-0 bg-neutral-900/50 backdrop-blur-sm"
          />
          <section className="relative my-8 w-full max-w-3xl rounded-2xl border border-neutral-200 bg-white shadow-modal overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-neutral-100 px-6 py-4">
              <h2 className="text-sm font-mono text-neutral-700 break-all">{openContent.path}</h2>
              <div className="flex items-center gap-4 shrink-0">
                {searchParams.open && !openContent.path.startsWith("/dreams-pending/") && (
                  <DeleteDreamButton id={searchParams.open} redirectAfter />
                )}
                <a href="/dreams" className="text-xs font-medium text-neutral-500 hover:underline">Cerrar</a>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Estado en lenguaje claro */}
              {openContent.path.startsWith("/dreams-pending/") ? (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-amber-800">
                    ⏳ <span className="font-semibold">Todavía NO se aplica.</span> El agente no usa
                    este aprendizaje hasta que lo apruebes.
                  </p>
                  {searchParams.open && <PendingDreamActions id={searchParams.open} />}
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="text-sm text-emerald-800">
                    ✅ <span className="font-semibold">Activo.</span> El agente ya usa este
                    aprendizaje en sus respuestas.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                {openContent.meta.severity && (
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${severityColor[openContent.meta.severity] ?? "bg-neutral-100 text-neutral-700"}`}>
                    {openContent.meta.severity}
                  </span>
                )}
                {openContent.meta.category && (
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${categoryColor[openContent.meta.category] ?? "bg-neutral-100 text-neutral-700"}`}>
                    {openContent.meta.category}
                  </span>
                )}
                {openContent.meta.vertical && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-100 text-neutral-700">
                    {openContent.meta.vertical}
                  </span>
                )}
                {openContent.meta.period && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-100 text-neutral-700">
                    {openContent.meta.period}
                  </span>
                )}
                {openContent.meta.date && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-100 text-neutral-700">
                    {openContent.meta.date}
                  </span>
                )}
              </div>

              <BodyWithLeadLinks
                body={openContent.body}
                leadRefs={parseLeadRefs(openContent.meta)}
              />
              {Object.keys(parseLeadRefs(openContent.meta)).length > 0 && (
                <p className="text-xs text-neutral-400">
                  💡 Los <span className="font-medium text-blue-700">Lead#N</span> en azul son
                  clickeables: te llevan a la conversación real de ese cliente.
                </p>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Sección pendientes — solo si no hay error de carga */}
      {!listError && parsedPending.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
              Pendientes de aprobación ({parsedPending.length})
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Estos aprendizajes NO se aplican hasta que los apruebes.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="sticky top-0 bg-neutral-50 text-left">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">Fecha</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">Severidad</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">Título</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 text-right"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {parsedPending.map((d) => (
                    <tr key={d.id} className="hover:bg-neutral-50/70 transition-colors">
                      <td className="px-4 py-3 text-xs text-neutral-600">{d.date}</td>
                      <td className="px-4 py-3">
                        {d.sev ? (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY[d.sev].cls}`}>
                            {SEVERITY[d.sev].label}
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-900 capitalize">
                        <a href={`/dreams?open=${d.id}`} className="hover:underline">
                          {d.title}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <PendingDreamActions id={d.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Sección activos — solo si no hay error de carga */}
      {!listError && (
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Aprendizajes activos ({parsedItems.length})
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Estos ya están funcionando: el agente los lee antes de cada respuesta.
          </p>
        </div>
        {parsedItems.length === 0 ? (
          <EmptyState
            icon={<Stars size={20} />}
            title="Sin aprendizajes activos todavía."
            description="Una vez que haya conversaciones, los análisis corren automáticamente cada noche y cada semana."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {parsedItems.map((d) => (
              <div
                key={d.id}
                className="group rounded-xl border border-neutral-200 bg-white p-4 shadow-card hover:shadow-pop hover:-translate-y-0.5 transition-all duration-200"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex flex-wrap gap-1">
                    {d.sev && (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY[d.sev].cls}`}>
                        {SEVERITY[d.sev].label}
                      </span>
                    )}
                    {d.period && (
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-100 text-neutral-600">
                        {d.period}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-neutral-400">{d.date}</span>
                </div>
                <p className="text-sm font-medium text-neutral-900 leading-snug line-clamp-2 capitalize">
                  {d.title}
                </p>
                <div className="mt-3 flex items-center justify-end gap-3">
                  <a
                    href={`/dreams?open=${d.id}`}
                    className="text-xs font-medium text-brand hover:text-brand-strong transition-colors"
                  >
                    Ver →
                  </a>
                  <DeleteDreamButton id={d.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}
    </PageShell>
  );
}
