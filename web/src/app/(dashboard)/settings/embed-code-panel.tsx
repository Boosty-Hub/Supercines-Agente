"use client";

import { useState } from "react";

export function EmbedCodePanel({ baseUrl }: { baseUrl: string }) {
  const [copied, setCopied] = useState(false);

  const code = `<iframe\n  src="${baseUrl}/inbox?mode=embed"\n  width="100%"\n  height="100%"\n  style="border:none"\n></iframe>`;

  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm font-mono leading-relaxed text-neutral-800">
          {code}
        </pre>
        <button
          type="button"
          onClick={copy}
          className={`absolute right-3 top-3 rounded-lg border px-3 py-1 text-xs font-medium shadow-sm transition-colors ${
            copied
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
          }`}
        >
          {copied ? "✓ Copiado" : "Copiar"}
        </button>
      </div>

      <details className="group rounded-lg border border-neutral-200 bg-neutral-50">
        <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-medium text-neutral-700 marker:content-none">
          <span>¿Cómo evitar que pida login?</span>
          <svg
            className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-180"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </summary>
        <div className="border-t border-neutral-200 px-4 py-3 text-xs text-neutral-600 space-y-2">
          <p>Generá un enlace de acceso automático desde el backend de tu app:</p>
          <pre className="overflow-x-auto rounded-lg bg-white border border-neutral-200 p-3 text-[11px] text-neutral-700 leading-relaxed">{`const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)\nconst { data } = await supabase.auth.admin.generateLink({\n  type: 'magiclink',\n  email: 'usuario@agente.com',\n  options: { redirectTo: '${baseUrl}/inbox?mode=embed' }\n})\n// data.properties.action_link → usalo como src del iframe`}</pre>
        </div>
      </details>
    </div>
  );
}
