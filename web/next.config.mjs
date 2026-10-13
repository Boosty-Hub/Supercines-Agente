import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // El repo tiene DOS lockfiles (raíz y web/): sin esto Next infiere el workspace root
  // por el lockfile más cercano a la raíz y avisa en cada build. La app solo traza
  // archivos de web/ en runtime (embed-provision lee ../supabase únicamente en el build).
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  async redirects() {
    return [
      {
        // Links viejos del inbox (alertas, Dreams, Leads, favoritos): /inbox?lead=<id>
        // → /inbox/<id>. Va acá y no solo en inbox/page.tsx porque ahí el redirect
        // cae dentro del streaming del layout y, navegando desde el propio inbox,
        // no siempre se aplica.
        source: "/inbox",
        has: [{ type: "query", key: "lead", value: "(?<lead>[0-9a-fA-F-]{36})" }],
        destination: "/inbox/:lead",
        permanent: false,
      },
    ];
  },
  async headers() {
    // Secure default: solo permite iframe desde el mismo origen.
    // El middleware sobreescribe este header a frame-ancestors * cuando
    // el modo embed está activo (?mode=embed o cookie embed_mode=1).
    // Para restringir a un dominio específico: EMBED_ORIGINS=https://tuapp.com
    const origins = process.env.EMBED_ORIGINS || "'self'";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${origins}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
