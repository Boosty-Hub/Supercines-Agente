"use client";

// Panel con la URL del webhook de Kommo (YA con el secreto) y su seguridad. Se usa en
// el wizard /setup (paso Kommo) y en Configuración → Kommo.
// La URL es la Edge Function kommo-webhook: <SUPABASE_URL>/functions/v1/kommo-webhook?token=<secreto>.
// Kommo no firma sus webhooks: el secreto en la URL es el único control posible. Cualquiera
// que NO lo conozca no puede falsificar eventos (por ejemplo, congelar un lead en una etapa).
//
// Transición sin downtime: los clientes que ya tenían el webhook sin secreto arrancan en
// modo «transición» (se acepta todo, con alerta). El operador pone la URL nueva en Kommo
// (a mano o con el botón) y pasa a modo estricto; si no lo hace, pasa solo cuando llegan
// requests con secreto y pasan 24 h sin requests sin secreto. Pasar a estricto a mano cuando
// Kommo todavía no usa la clave lo frena el servidor (409); el panel muestra el motivo y solo
// fuerza con confirmación explícita. Si al rotar Kommo no se pudo actualizar, es un ERROR
// visible con el botón «Actualizar en Kommo» a mano (la clave ya rotó).

import { useCallback, useEffect, useState } from "react";

const STEPS = [
  "En Kommo, andá a Configuración → Integraciones.",
  "Buscá «Webhooks» y abrilo → «Añadir webhook» (o editá el que ya tenías).",
  "Pegá la URL de arriba COMPLETA (incluye el ?token=) en el campo de la URL del webhook.",
  "Tildá los eventos: «Mensaje entrante» (chat), «Lead añadido» y «Lead modificado».",
  "Guardá. Listo: los mensajes de tus leads ya llegan a tu agente.",
];

type State = {
  url: string | null;
  mode: "permissive" | "strict";
  strictAfterHours: number;
  strictSince: string | null;
  strictReason: string | null;
  lastSignedAt: string | null;
  lastUnsignedAt: string | null;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
  rotationPending: boolean;
  strictBlocker: { code: string; message: string } | null;
  secretConfigured: boolean;
};

type ActResult = { ok: true; j: Record<string, unknown> } | { ok: false; status: number; j: Record<string, unknown> };

const REJECT_LABEL: Record<string, string> = {
  bad_token: "clave incorrecta",
  unsigned_strict: "sin clave (modo estricto)",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es") : "nunca");

export function KommoWebhookPanel() {
  const [st, setSt] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Error de Kommo tras rotar: la clave nueva ya rige en la base pero Kommo sigue con la vieja.
  const [kommoError, setKommoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/kommo/webhook-auth", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Error ${r.status}`);
      setSt(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<ActResult> {
    const r = await fetch("/api/kommo/webhook-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return r.ok ? { ok: true, j } : { ok: false, status: r.status, j };
  }

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      let res = await post(body);
      // Pasar a estricto cortaría el webhook real: el servidor lo frena con el motivo.
      if (!res.ok && res.status === 409 && res.j.needsForce === true) {
        const motivo = String(res.j.error ?? "");
        if (!window.confirm(`${motivo}\n\n¿Pasar a modo estricto de todos modos?`)) return;
        res = await post({ ...body, force: true });
      }
      if (!res.ok) throw new Error(String(res.j.error ?? `Error ${res.status}`));
      if (body.action === "rotate" && res.j.kommoError) {
        setKommoError(String(res.j.kommoError));
      } else {
        if (body.action === "rotate" || body.action === "apply") setKommoError(null);
        setMsg(ok);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const applyNow = () => act({ action: "apply" }, "Kommo ahora apunta a la URL con clave.");

  async function copy() {
    if (!st?.url) return;
    try {
      await navigator.clipboard.writeText(st.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  const url = st?.url ?? "";
  const strict = st?.mode === "strict";

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-neutral-900">Conectá el webhook de Kommo</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Para que los mensajes de tus leads lleguen al agente, Kommo tiene que avisarle a esta dirección cada vez que
          pasa algo. La dirección incluye una clave secreta (<code>?token=</code>): sin ella nadie más puede enviarle
          eventos falsos al sistema.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 space-y-2">
        <p className="text-xs font-medium text-neutral-600">URL del webhook</p>
        <div className="flex items-start justify-between gap-2">
          <code className="break-all text-xs text-neutral-900">
            {url || (error ? "No se pudo cargar la URL." : st ? "Configurá Supabase primero (paso 1)." : "Cargando…")}
          </code>
          <button
            type="button"
            onClick={copy}
            disabled={!url}
            className="flex-shrink-0 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-40"
          >
            {copied ? "¡Copiado!" : "Copiar"}
          </button>
        </div>
        {url && (
          <a
            href={url.split("?")[0]}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-violet-600 underline"
          >
            Probar (abre en otra pestaña — debe decir «kommo-webhook OK»)
          </a>
        )}
      </div>

      {st && (
        <div
          className={`rounded-lg border p-3 space-y-2 text-xs ${
            strict ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <p className="font-medium">
            {strict ? "Modo estricto: solo se aceptan requests con la clave." : "Modo transición: se aceptan también requests SIN clave."}
          </p>
          <p>
            Última request con clave: {fmt(st.lastSignedAt)} · última sin clave: {fmt(st.lastUnsignedAt)}.
            {!strict &&
              ` Pasa solo a estricto cuando llegan requests con clave y pasan ${st.strictAfterHours} h sin requests sin clave.`}
            {strict && st.strictSince && ` Activo desde ${fmt(st.strictSince)} (${st.strictReason === "auto" ? "automático" : "manual"}).`}
          </p>
          {st.lastRejectedAt && (
            <p>
              Último descarte: {fmt(st.lastRejectedAt)} ({REJECT_LABEL[st.lastRejectedReason ?? ""] ?? st.lastRejectedReason}). Los
              descartes no se encolan: si era Kommo, actualizá su URL.
            </p>
          )}
          {st.rotationPending && (
            <p className="font-medium">
              Rotación pendiente: Kommo todavía no usó la clave nueva (la anterior sigue valiendo). Hasta confirmarla no se
              puede volver a rotar.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !st.secretConfigured}
              onClick={applyNow}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
            >
              Actualizar en Kommo automáticamente
            </button>
            {strict ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => act({ action: "set_mode", mode: "permissive" }, "Volvió al modo transición.")}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
              >
                Volver a modo transición
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const aviso = st.strictBlocker
                    ? `${st.strictBlocker.message}\n\n¿Pasar a modo estricto de todos modos?`
                    : "¿Ya actualizaste la URL en Kommo? En modo estricto, el webhook que siga sin la clave dejará de funcionar.";
                  if (window.confirm(aviso)) {
                    void act(
                      { action: "set_mode", mode: "strict", ...(st.strictBlocker ? { force: true } : {}) },
                      "Modo estricto activado.",
                    );
                  }
                }}
                className="rounded-md bg-neutral-900 px-2.5 py-1 font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
              >
                Ya lo actualicé: pasar a modo estricto
              </button>
            )}
            <button
              type="button"
              disabled={busy || !st.secretConfigured || st.rotationPending}
              title={st.rotationPending ? "Primero confirmá la rotación anterior («Actualizar en Kommo»)." : undefined}
              onClick={() => {
                if (window.confirm("Se genera otra clave. La anterior sigue valiendo 24 h para que cambies la URL en Kommo sin cortes. ¿Rotar?")) {
                  void act({ action: "rotate" }, "Clave rotada.");
                }
              }}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
            >
              Rotar clave
            </button>
          </div>
        </div>
      )}

      {kommoError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 space-y-2">
          <p className="font-medium">La clave rotó, pero Kommo NO se actualizó: {kommoError}</p>
          <p>
            Kommo sigue usando la clave anterior, que vale 24 h. Actualizalo antes de que venza o los mensajes dejarán de
            entrar.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={applyNow}
            className="rounded-md bg-neutral-900 px-2.5 py-1 font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
          >
            Actualizar en Kommo
          </button>
        </div>
      )}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}

      <details className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
        <summary className="cursor-pointer text-xs font-medium text-neutral-600 select-none hover:text-neutral-900">
          ¿Cómo conectarlo en Kommo? (5 pasos)
        </summary>
        <ol className="mt-3 space-y-2">
          {STEPS.map((s, i) => (
            <li key={i} className="flex gap-3 text-xs text-neutral-600">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-700">
                {i + 1}
              </span>
              <span className="leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
