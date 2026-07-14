// Fallback de Suspense para todas las rutas del dashboard. Aparece al
// instante al navegar mientras el servidor renderiza la página real,
// dando feedback inmediato (el sidebar queda fijo, solo cambia esto).
export default function DashboardLoading() {
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6 max-w-6xl animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-48 rounded-lg bg-neutral-200" />
        <div className="h-4 w-80 max-w-full rounded bg-neutral-200/70" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
          >
            <div className="h-3 w-20 rounded bg-neutral-200" />
            <div className="mt-3 h-6 w-16 rounded-full bg-neutral-200" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-3">
          <div className="h-3 w-24 rounded bg-neutral-200" />
        </div>
        <div className="divide-y divide-neutral-100">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <div className="h-4 w-32 rounded bg-neutral-200" />
              <div className="h-4 w-24 rounded bg-neutral-200/70" />
              <div className="ml-auto h-4 w-16 rounded bg-neutral-200/70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
