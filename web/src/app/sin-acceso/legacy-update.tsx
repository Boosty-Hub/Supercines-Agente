"use client";

// Transición: el maestro sin rol de un despliegue anterior aplica las migraciones pendientes desde
// acá; la de roles (0078) le asigna `configuracion` y con eso vuelve a entrar al panel. Solo se
// muestra mientras esa migración no esté aplicada (lo decide la página y lo vuelve a exigir la ruta).
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function LegacyUpdate() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function aplicar() {
    setBusy(true);
    setError(null);
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/provision/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean; done?: boolean; justApplied?: string | null; applied?: number; total?: number; error?: string;
        };
        if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.applied !== undefined && j.total !== undefined) setProgress(`Migraciones ${j.applied}/${j.total}…`);
        if (j.done || !j.justApplied) break;
      }
      // El rol ya está asignado: el panel completa el resto (funciones) desde el aviso de actualizaciones.
      window.location.href = "/inbox";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p>
        Esta instalación tiene actualizaciones de base de datos pendientes. Si sos el administrador original
        (de antes de que existieran los alcances), aplicarlas te asigna el alcance Administrador.
      </p>
      {progress && <p className="text-xs">{progress}</p>}
      {error && <p className="font-mono text-xs text-red-700">{error}</p>}
      <Button type="button" busy={busy} onClick={() => void aplicar()}>
        Aplicar actualizaciones
      </Button>
    </div>
  );
}
