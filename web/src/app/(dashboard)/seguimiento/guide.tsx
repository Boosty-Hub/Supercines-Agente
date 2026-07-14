// Guía "Cómo funciona el seguimiento" — colapsable (details/summary nativo,
// colapsada por defecto). Lenguaje de operador: NADA técnico (sin nombres de
// tablas, columnas, endpoints ni pasos de Supabase). Todo se hace desde acá.
export function Guide() {
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 p-5 [&::-webkit-details-marker]:hidden">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">
          Cómo funciona el seguimiento
        </h2>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-neutral-400">
          <span className="group-open:hidden">Ver explicación</span>
          <span className="hidden group-open:inline">Ocultar</span>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
            className="h-4 w-4 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
          >
            <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </summary>

      <div className="space-y-3 px-5 pb-5 text-sm text-neutral-700">
        <p className="text-neutral-600">
          El seguimiento vuelve a escribirle, solo, a los leads que se quedaron sin contestar —
          para reactivarlos antes de que se enfríen. Siempre dentro de tu horario y con mensajes
          que vos aprobás. Lo configurás todo desde acá; no hace falta saber nada técnico.
        </p>

        <div className="space-y-1">
          <p className="font-medium text-neutral-900">Mensajes aprobados de WhatsApp</p>
          <p>
            WhatsApp solo deja escribirle a alguien que no responde hace rato usando{" "}
            <span className="font-medium text-neutral-700">plantillas aprobadas</span>. Vos cargás
            esas plantillas acá (en la pestaña Plantillas) y el agente solo completa los datos de
            cada lead, como el nombre. El texto base de la plantilla no cambia.
          </p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-neutral-900">La aprobación se hace una vez, por fuera</p>
          <p>
            Las plantillas las aprueba WhatsApp/Meta (a través de tu proveedor) antes de poder
            usarlas — eso es un trámite que se hace una sola vez. Acá solo pegás la plantilla que
            ya quedó aprobada y elegís el bot que la envía.
          </p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-neutral-900">Cuándo se reactiva un lead</p>
          <p>
            El reloj cuenta desde el{" "}
            <span className="font-medium text-neutral-700">último mensaje del lead</span>, no desde
            tus respuestas. Si pasa el tiempo que vos definís y el lead sigue sin contestar, recibe
            el primer seguimiento. Si tampoco contesta, sigue con el siguiente paso de la secuencia,
            hasta el máximo que pongas.
          </p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-neutral-900">Arranca apagado, a propósito</p>
          <p>
            El seguimiento viene <span className="font-medium text-neutral-700">desactivado</span>{" "}
            hasta que vos lo prendas. Así nadie recibe mensajes automáticos hasta que esté todo como
            lo querés.
          </p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-neutral-900">Cómo activarlo</p>
          <ol className="list-decimal list-inside space-y-0.5 text-neutral-600">
            <li>
              En <span className="font-medium text-neutral-700">Plantillas</span>, cargá al menos
              una plantilla con su bot y los datos que el agente completa.
            </li>
            <li>
              En <span className="font-medium text-neutral-700">Secuencia</span>, definí cuántos
              seguimientos enviar y cada cuánto tiempo.
            </li>
            <li>
              En <span className="font-medium text-neutral-700">Configuración global</span>, elegí
              (si querés) en qué etapas y a qué vendedores aplica.
            </li>
            <li>
              Prendé el interruptor <span className="font-medium text-neutral-700">Seguimiento
              activado</span> y guardá. Listo: el agente se encarga del resto.
            </li>
          </ol>
        </div>
      </div>
    </details>
  );
}
