"use client";

// ID del lead en Kommo: click sobre el número = copiar; el link abre la
// ficha del lead en Kommo en otra pestaña (si hay subdominio configurado).

import { useState } from "react";

export function KommoLeadLink({
  kommoLeadId,
  subdomain,
}: {
  kommoLeadId: number | null;
  subdomain: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (kommoLeadId == null) return <span>lead: —</span>;

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(kommoLeadId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard no disponible (http/permiso): no romper nada
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={copy}
        title="Copiar ID del lead"
        className="cursor-pointer rounded px-0.5 font-mono text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
      >
        {copied ? "✓ copiado" : `#${kommoLeadId}`}
      </button>
      {subdomain && (
        <a
          href={`https://${subdomain}.kommo.com/leads/detail/${kommoLeadId}`}
          target="_blank"
          rel="noreferrer"
          title="Abrir el lead en Kommo"
          className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-medium text-brand transition-colors hover:bg-brand-soft"
        >
          Kommo ↗
        </a>
      )}
    </span>
  );
}
