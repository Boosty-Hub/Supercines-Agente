import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Tokens de marca — configurables via CSS var; default = indigo-600
        brand: "rgb(var(--brand) / <alpha-value>)",
        "brand-foreground": "rgb(var(--brand-foreground) / <alpha-value>)",
        "brand-soft": "rgb(var(--brand-soft) / <alpha-value>)",
        "brand-strong": "rgb(var(--brand-strong) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      boxShadow: {
        // Sombras semánticas (uso: tarjetas=shadow-card, modales=shadow-modal, dropdowns=shadow-pop)
        card: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        modal: "0 10px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
        pop: "0 4px 12px -2px rgb(0 0 0 / 0.08)",
      },
      // Contrato de radios (NO redefinir, solo documentar uso):
      // Tarjetas y modales: rounded-xl (0.75rem)
      // Botones, inputs, links-botón: rounded-lg (0.5rem)
      // Badges, pills, contadores: rounded-full
    },
  },
  plugins: [],
};
export default config;
