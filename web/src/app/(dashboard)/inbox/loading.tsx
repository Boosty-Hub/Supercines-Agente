// Fallback de Suspense para el Inbox — replica el layout de dos paneles
// para que la transición sea fluida (no se ve un salto de layout).
export default function InboxLoading() {
  return (
    <div className="flex h-full animate-pulse bg-neutral-50">
      {/* Lista de leads */}
      <aside className="hidden w-96 flex-col border-r border-neutral-200 bg-white lg:flex">
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="h-5 w-24 rounded bg-neutral-200" />
          <div className="mt-2 h-3 w-40 rounded bg-neutral-200/70" />
        </div>
        <div className="divide-y divide-neutral-100">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-neutral-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-32 rounded bg-neutral-200" />
                <div className="h-3 w-44 rounded bg-neutral-200/70" />
                <div className="h-3 w-16 rounded-full bg-neutral-200/70" />
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Conversación */}
      <section className="hidden flex-1 flex-col lg:flex">
        <div className="border-b border-neutral-200 bg-white px-5 py-3">
          <div className="h-4 w-40 rounded bg-neutral-200" />
          <div className="mt-2 h-3 w-56 rounded bg-neutral-200/70" />
        </div>
        <div className="flex-1 space-y-4 p-6">
          <div className="h-16 w-2/3 rounded-2xl bg-neutral-200" />
          <div className="ml-auto h-20 w-2/3 rounded-2xl bg-neutral-200/70" />
          <div className="h-12 w-1/2 rounded-2xl bg-neutral-200" />
        </div>
      </section>

      {/* Móvil: solo lista */}
      <div className="flex-1 space-y-3 p-4 lg:hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-16 rounded-xl bg-white shadow-sm" />
        ))}
      </div>
    </div>
  );
}
