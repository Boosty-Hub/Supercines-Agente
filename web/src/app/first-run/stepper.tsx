"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

export type FirstRunStep =
  | "connect-supabase"
  | "initialize"
  | "create-user"
  | "anthropic"
  | "kommo"
  | "done";

const STEPS: { key: FirstRunStep; label: string }[] = [
  { key: "connect-supabase", label: "Conectar" },
  { key: "initialize", label: "Inicializar" },
  { key: "create-user", label: "Usuario" },
  { key: "anthropic", label: "Anthropic" },
  { key: "kommo", label: "Kommo" },
  { key: "done", label: "Listo" },
];

function stepIndex(step: FirstRunStep): number {
  return STEPS.findIndex((s) => s.key === step);
}

export function ProvisionStepper({ currentStep }: { currentStep: FirstRunStep }) {
  const current = stepIndex(currentStep);

  return (
    <ol className="flex flex-wrap items-center gap-1">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.key} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-brand text-brand-foreground"
                  : done
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-neutral-100 text-neutral-400"
              }`}
            >
              {done ? (
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M2 6.5L4.5 9l5.5-5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span className="text-[10px] font-bold">{i + 1}</span>
              )}
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-neutral-300 text-xs select-none">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
