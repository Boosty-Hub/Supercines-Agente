// Fallback de Suspense del panel de conversación. La lista/tablero la pinta el
// layout (inbox-shell.tsx) con su propio esqueleto, así que acá va solo el panel
// derecho: es lo que se ve mientras se abre una conversación.
export default function ConversationLoading() {
  return (
    <div className="flex h-full animate-pulse flex-col" aria-busy="true" aria-label="Cargando conversación">
      <div className="border-b border-neutral-200 bg-white px-5 py-3">
        <div className="h-4 w-40 rounded bg-neutral-200" />
        <div className="mt-2 h-3 w-56 rounded bg-neutral-200/70" />
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6 sm:px-6">
        <div className="h-16 w-2/3 rounded-2xl bg-neutral-200" />
        <div className="ml-auto h-20 w-2/3 rounded-2xl bg-neutral-200/70" />
        <div className="h-12 w-1/2 rounded-2xl bg-neutral-200" />
        <div className="ml-auto h-16 w-1/2 rounded-2xl bg-neutral-200/70" />
      </div>
    </div>
  );
}
