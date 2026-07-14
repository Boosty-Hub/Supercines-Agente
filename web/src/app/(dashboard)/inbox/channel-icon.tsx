// Logos oficiales de canal (SVG inline, vectorial, sin dependencias ni fetch).
// El valor de `channel` viene de process-inbound (originToChannel): whatsapp,
// instagram_dm, facebook, telegram, tiktok, web_form, unknown, etc.

type Props = { channel: string | null | undefined; size?: number; className?: string };

function normalize(ch: string): string {
  const c = ch.toLowerCase();
  if (c.includes("whatsapp") || c === "waba") return "whatsapp";
  if (c.includes("instagram")) return "instagram";
  if (c.includes("facebook") || c === "fb") return "facebook";
  if (c.includes("tiktok")) return "tiktok";
  if (c.includes("telegram")) return "telegram";
  return "other";
}

const LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  telegram: "Telegram",
  other: "Otro canal",
};

export default function ChannelIcon({ channel, size = 16, className }: Props) {
  if (!channel) return null;
  const kind = normalize(channel);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    role: "img" as const,
    "aria-label": LABELS[kind],
    className,
  };

  if (kind === "whatsapp") {
    return (
      <svg {...common}>
        <title>{LABELS[kind]}</title>
        <path
          fill="#25D366"
          d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"
        />
      </svg>
    );
  }

  if (kind === "facebook") {
    return (
      <svg {...common}>
        <title>{LABELS[kind]}</title>
        <path
          fill="#0866FF"
          d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073Z"
        />
      </svg>
    );
  }

  if (kind === "instagram") {
    return (
      <svg {...common}>
        <title>{LABELS[kind]}</title>
        <defs>
          <radialGradient id="ig-grad" cx="0.3" cy="1" r="1.1">
            <stop offset="0" stopColor="#FFD776" />
            <stop offset="0.25" stopColor="#F3A145" />
            <stop offset="0.5" stopColor="#E8483F" />
            <stop offset="0.75" stopColor="#D6249F" />
            <stop offset="1" stopColor="#7536D3" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="24" height="24" rx="6" fill="url(#ig-grad)" />
        <rect
          x="5"
          y="5"
          width="14"
          height="14"
          rx="4.2"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="12" r="3.4" fill="none" stroke="#fff" strokeWidth="1.8" />
        <circle cx="16.4" cy="7.6" r="1.1" fill="#fff" />
      </svg>
    );
  }

  if (kind === "tiktok") {
    const note =
      "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z";
    return (
      <svg {...common}>
        <title>{LABELS[kind]}</title>
        <rect x="0" y="0" width="24" height="24" rx="6" fill="#000" />
        <g transform="scale(0.62) translate(7.4 7.4)">
          <path d={note} fill="#25F4EE" transform="translate(-0.7 -0.7)" />
          <path d={note} fill="#FE2C55" transform="translate(0.7 0.7)" />
          <path d={note} fill="#fff" />
        </g>
      </svg>
    );
  }

  if (kind === "telegram") {
    return (
      <svg {...common}>
        <title>{LABELS[kind]}</title>
        <path
          fill="#26A5E4"
          d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.061 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.44-.751-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
        />
      </svg>
    );
  }

  // Canal genérico / desconocido — chat genérico neutro
  return (
    <svg {...common}>
      <title>{channel}</title>
      <path
        fill="#9CA3AF"
        d="M12 2C6.48 2 2 6.04 2 11c0 2.6 1.23 4.94 3.2 6.58L4 22l4.9-2.06c.98.27 2.02.42 3.1.42 5.52 0 10-4.04 10-9S17.52 2 12 2Z"
      />
    </svg>
  );
}
