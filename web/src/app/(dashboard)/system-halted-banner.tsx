import Link from "next/link";

// Franja fija arriba de TODO el sistema (sidebar + main, y también en modo
// embed) cuando `system_halted=true` — el kill switch que corta las seis
// funciones que consumen IA (o publican en Kommo). Server component: el
// estado ya viene resuelto del layout, no necesita interactividad propia.
export function SystemHaltedBanner() {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">
      <span aria-hidden>⛔</span>
      <span>Sistema apagado por completo — nada está consumiendo IA en este momento.</span>
      <Link href="/settings#panel-control" className="underline underline-offset-2 hover:text-white/80">
        Ir al Panel de control
      </Link>
    </div>
  );
}
