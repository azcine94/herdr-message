import React, { useId } from 'react';
import antigravityColorUrl from '@lobehub/icons-static-svg/icons/antigravity-color.svg';
import claudeColorUrl from '@lobehub/icons-static-svg/icons/claude-color.svg';
import devinColorUrl from '@lobehub/icons-static-svg/icons/devin-color.svg';
import geminiColorUrl from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import { AgentBrand } from '../types/monitor';

interface BrandLogoProps {
  brand: AgentBrand;
  size?: number;
  bare?: boolean;
  className?: string;
}

const CONTAINER_STYLES: Record<AgentBrand, string> = {
  codex: 'bg-[#6E7BFF]/14 ring-1 ring-[#8B97FF]/28',
  devin: 'bg-[#1599E2]/13 ring-1 ring-[#21C19A]/26',
  agy: 'bg-white/[0.06] ring-1 ring-white/[0.13]',
  claude: 'bg-[#D97757]/14 ring-1 ring-[#D97757]/28',
  cursor: 'bg-white/[0.08] text-zinc-100 ring-1 ring-white/[0.16]',
  gemini: 'bg-[#3186FF]/13 ring-1 ring-[#3186FF]/26',
  opencode: 'bg-white/[0.07] text-zinc-200 ring-1 ring-white/[0.15]',
  terminal: 'bg-zinc-500/15 text-zinc-300 ring-1 ring-white/[0.12]',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({
  brand,
  size = 28,
  bare = false,
  className = '',
}) => {
  const uid = useId();
  const glyphSize = bare ? size : Math.round(size * 0.62);

  const renderGlyph = () => {
    switch (brand) {
      case 'codex': {
        // Official OpenAI Codex Scalloped Prompt Mark with official Indigo-Periwinkle gradient
        const gradId = `codex-grad-${uid}`;
        return (
          <svg
            width={glyphSize}
            height={glyphSize}
            viewBox="0 0 24 24"
            fill="none"
            aria-label="Codex"
          >
            <defs>
              <linearGradient id={gradId} x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
                <stop stopColor="#C4BCFF" />
                <stop offset="0.52" stopColor="#85A4FF" />
                <stop offset="1" stopColor="#525BFF" />
              </linearGradient>
            </defs>
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              fill={`url(#${gradId})`}
              d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
            />
          </svg>
        );
      }

      case 'devin':
        // Official Cognition Devin 3-Ribbon Color Vector Mark
        return (
          <img
            src={devinColorUrl}
            alt="Devin"
            width={glyphSize}
            height={glyphSize}
            style={{ width: glyphSize, height: glyphSize }}
            draggable={false}
            className="object-contain select-none shrink-0"
          />
        );

      case 'agy':
        // Official Google Antigravity Color Mesh Vector Mark
        return (
          <img
            src={antigravityColorUrl}
            alt="Antigravity"
            width={glyphSize}
            height={glyphSize}
            style={{ width: glyphSize, height: glyphSize }}
            draggable={false}
            className="object-contain select-none shrink-0"
          />
        );

      case 'claude':
        // Official Anthropic Claude Starburst Color Mark
        return (
          <img
            src={claudeColorUrl}
            alt="Claude Code"
            width={glyphSize}
            height={glyphSize}
            style={{ width: glyphSize, height: glyphSize }}
            draggable={false}
            className="object-contain select-none shrink-0"
          />
        );

      case 'gemini':
        // Official Google Gemini Gradient Sparkle Mark
        return (
          <img
            src={geminiColorUrl}
            alt="Gemini"
            width={glyphSize}
            height={glyphSize}
            style={{ width: glyphSize, height: glyphSize }}
            draggable={false}
            className="object-contain select-none shrink-0"
          />
        );

      case 'cursor':
        // Official Cursor 3D Isometric Cube Mark
        return (
          <svg
            width={glyphSize}
            height={glyphSize}
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
            aria-label="Cursor"
          >
            <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
          </svg>
        );

      case 'opencode':
        // Official OpenCode Frame Mark
        return (
          <svg
            width={glyphSize}
            height={glyphSize}
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
            aria-label="OpenCode"
          >
            <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
          </svg>
        );

      default:
        return (
          <svg
            width={glyphSize}
            height={glyphSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-label="Terminal"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        );
    }
  };

  if (bare) {
    return (
      <span
        className={`inline-flex items-center justify-center shrink-0 text-zinc-200 ${className}`}
        style={{ width: size, height: size }}
      >
        {renderGlyph()}
      </span>
    );
  }

  const radius = size <= 24 ? 'rounded-full' : 'rounded-xl';

  return (
    <div
      className={`inline-flex items-center justify-center shrink-0 ${radius} ${CONTAINER_STYLES[brand]} ${className}`}
      style={{ width: size, height: size }}
    >
      {renderGlyph()}
    </div>
  );
};
