"use client";

// Selector visual de USUARIOS RESPONSABLES (vendedores) de Kommo para el
// seguimiento. Espeja a StageSelector: trae los usuarios reales desde
// /api/kommo/users y deja marcar a quiénes se les permite seguimiento.
// Si Kommo no está conectado o la lectura falla, cae a mostrar los IDs
// guardados como chips para no perder la configuración.

import { useEffect, useState } from "react";

type KUser = { id: number; name: string; email?: string | null };

export function UserSelector({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [users, setUsers] = useState<KUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/kommo/users", { cache: "no-store" });
        const j = await res.json();
        if (cancelled) return;
        if (!j.ok) {
          setError(j.error ?? "No se pudieron leer los usuarios de Kommo.");
          setUsers(null);
        } else if (!j.configured) {
          setError("Kommo todavía no está conectado.");
          setUsers(null);
        } else {
          setUsers((j.users ?? []) as KUser[]);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Error de red");
          setUsers(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = new Set(value);
  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next).sort((a, b) => a - b));
  }

  // Mapa id→nombre para mostrar chips legibles aún si la lectura falla.
  const userName = new Map<number, string>();
  (users ?? []).forEach((u) => userName.set(u.id, u.name));

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-neutral-600">
        Vendedores cuyos leads reciben seguimiento
      </label>
      <p className="text-[11px] text-neutral-500">
        Marcá a qué responsables de Kommo se les hace seguimiento automático. Si no
        marcás ninguno, el seguimiento corre para{" "}
        <span className="font-medium">todos</span> los responsables.
      </p>

      {loading ? (
        <p className="text-xs text-neutral-400">Cargando usuarios de Kommo…</p>
      ) : error ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ {error}
          {value.length > 0 && (
            <span className="mt-1 block text-amber-700">
              Usuarios guardados:{" "}
              {value.map((id) => userName.get(id) ?? `#${id}`).join(", ")}.
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-neutral-200 p-3">
            <div className="flex flex-wrap gap-1.5">
              {(users ?? []).map((u) => {
                const on = selected.has(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggle(u.id)}
                    aria-pressed={on}
                    title={u.email ?? undefined}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      on
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                    }`}
                  >
                    {u.name}
                    {on && <span aria-hidden>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
          {value.length === 0 ? (
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-[11px] text-neutral-500">
              Ningún vendedor marcado → el seguimiento corre para todos.
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500">
              {value.length} vendedor{value.length === 1 ? "" : "es"} marcado
              {value.length === 1 ? "" : "s"} — solo sus leads reciben seguimiento.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
