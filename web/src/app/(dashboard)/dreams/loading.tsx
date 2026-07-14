// Fallback de Suspense para Dreams — evita el flash de "(0)" mientras
// se carga la lista del Memory Store de Anthropic.
export default function DreamsLoading() {
  return (
    <div className="animate-pulse">
      {/* Topbar skeleton */}
      <div className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex min-h-[52px] items-center justify-between gap-4 py-3">
            <div className="space-y-1.5">
              <div className="h-4 w-32 rounded bg-neutral-200" />
              <div className="h-3 w-64 rounded bg-neutral-200/70" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-8 w-28 rounded-lg bg-neutral-200" />
              <div className="h-8 w-28 rounded-lg bg-neutral-200" />
            </div>
          </div>
        </div>
      </div>

      {/* Contenido skeleton */}
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {/* Sección pendientes */}
        <div className="space-y-3">
          <div className="h-4 w-48 rounded bg-neutral-200" />
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-neutral-100 px-4 py-3">
                <div className="h-3 w-20 rounded bg-neutral-200" />
                <div className="h-5 w-16 rounded-full bg-neutral-200" />
                <div className="h-3 flex-1 rounded bg-neutral-200" />
              </div>
            ))}
          </div>
        </div>

        {/* Sección activos */}
        <div className="space-y-3">
          <div className="h-4 w-40 rounded bg-neutral-200" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                <div className="mb-2 flex items-center justify-between">
                  <div className="h-5 w-16 rounded-full bg-neutral-200" />
                  <div className="h-3 w-20 rounded bg-neutral-200/70" />
                </div>
                <div className="space-y-1.5">
                  <div className="h-3.5 w-full rounded bg-neutral-200" />
                  <div className="h-3.5 w-3/4 rounded bg-neutral-200/70" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
