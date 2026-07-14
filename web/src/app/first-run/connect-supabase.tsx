"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Platform = "netlify" | "vercel" | "other";

function detectPlatform(): Platform | null {
  // NEXT_PUBLIC_ prefix so it's inlined at build time when set
  const hint = process.env.NEXT_PUBLIC_HOST_HINT;
  if (hint === "netlify") return "netlify";
  if (hint === "vercel") return "vercel";
  return null;
}

// The block the user pastes into their host's "import from .env" field.
const ENV_BLOCK = `NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=`;

// Short, non-technical steps per host. Kept to the exact labels each UI shows.
const HOST_STEPS: Record<Platform, string[]> = {
  netlify: [
    "Abrí tu sitio en netlify.com",
    "Entrá a Project configuration → Environment variables",
    "Tocá Add a variable → Import from a .env file",
    "Pegá el bloque de acá abajo, completá los 3 valores y guardá",
    "Por último: Deploys → Trigger deploy → Clear cache and deploy site",
  ],
  vercel: [
    "Abrí tu proyecto en vercel.com",
    "Entrá a Settings → Environment Variables",
    "Pegá las 3 variables del bloque de abajo (entorno Production)",
    "Por último: Deployments → Redeploy",
  ],
  other: [
    "Abrí el panel de tu hosting",
    "Buscá la sección Environment Variables (entorno de producción)",
    "Agregá las 3 variables del bloque de abajo",
    "Guardá y volvé a desplegar la app",
  ],
};

const platformName: Record<Platform, string> = {
  netlify: "Netlify",
  vercel: "Vercel",
  other: "tu hosting",
};

export function ConnectSupabase({ onContinue }: { onContinue: () => void }) {
  const detected = detectPlatform();
  const [platform, setPlatform] = useState<Platform>(() => detected ?? "netlify");
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  // Poll /api/provision/status until Supabase env is detected (after redeploy)
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/provision/status");
        if (!res.ok) return;
        const data = (await res.json()) as { hasSupabaseEnv: boolean };
        if (data.hasSupabaseEnv && !cancelled) {
          setConnected(true);
          clearInterval(interval);
          setTimeout(() => {
            if (!cancelled) onContinue();
          }, 900);
        }
      } catch {
        /* keep polling */
      }
    }

    const interval = setInterval(poll, 2500);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [onContinue]);

  async function copyBlock() {
    try {
      await navigator.clipboard.writeText(ENV_BLOCK);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">
          Conectá tu base de datos
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Pegá 3 datos de tu proyecto Supabase en {platformName[platform]} y
          volvé a desplegar. Es la única vez que vas a tocar algo fuera de esta
          pantalla.
        </p>
      </div>

      {/* Platform selector — only if not auto-detected */}
      {!detected && (
        <div className="flex gap-2">
          {(["netlify", "vercel", "other"] as Platform[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPlatform(p)}
              className={`rounded-lg border px-4 py-1.5 text-xs font-medium transition-colors ${
                platform === p
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {p === "other" ? "Otro" : platformName[p]}
            </button>
          ))}
        </div>
      )}

      {/* Steps */}
      <ol className="space-y-2.5">
        {HOST_STEPS[platform].map((stepText, i) => (
          <li key={i} className="flex gap-3 text-sm text-neutral-700">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[11px] font-semibold text-white">
              {i + 1}
            </span>
            <span className="pt-0.5">{stepText}</span>
          </li>
        ))}
      </ol>

      {/* Copy-paste block */}
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-neutral-600">
            Pegá esto y completá los valores
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={copyBlock}
          >
            {copied ? "¡Copiado!" : "Copiar"}
          </Button>
        </div>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-neutral-900 px-3 py-2.5 text-xs leading-relaxed text-neutral-100">
          {ENV_BLOCK}
        </pre>
        <p className="mt-2 text-xs text-neutral-500">
          Los 3 valores están en Supabase → tu proyecto → <strong>Project
          Settings → API</strong>, sección <strong>Legacy API keys</strong> (las
          que empiezan con <code>eyJ…</code>).
        </p>
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>Importante:</strong> si en algún momento Netlify te ofrece
          marcar una variable como “secreta”, hacelo solo con{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code>. Las dos{" "}
          <code>NEXT_PUBLIC_*</code> tienen que quedar normales — si las marcás
          secretas, el navegador no las recibe y el login no funciona.
          (Importando por <code>.env</code> no te pregunta: quedan bien.)
        </p>
      </div>

      {/* Redeploy reminder — short and human */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm text-amber-800">
          Después de guardar, <strong>volvé a desplegar</strong> y reabrí esta
          página. Vamos a detectar la conexión y seguir solos.
        </p>
      </div>

      {/* Live connection status */}
      <div className="flex items-center gap-2 text-sm">
        {connected ? (
          <>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            <span className="font-medium text-emerald-700">
              ¡Conectado! Avanzando…
            </span>
          </>
        ) : (
          <>
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-300" />
            <span className="text-neutral-400">Esperando el redespliegue…</span>
          </>
        )}
      </div>
    </div>
  );
}
