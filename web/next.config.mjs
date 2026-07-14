/** @type {import('next').NextConfig} */
const nextConfig = {
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
