/**
 * GitHub (Primer) look. Tailwind's neutral and status scales are remapped to Primer's light and
 * dark palettes so existing `slate-*` / `dark:slate-*` pairs render as GitHub greys; chrome
 * components in index.css use Primer's semantic CSS variables directly.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Light values at the low end, dark-theme surfaces at the high end (Primer light/dark).
        slate: {
          50: "#f6f8fa",
          100: "#eff2f5",
          200: "#d1d9e0",
          300: "#d1d9e0",
          400: "#818b98",
          500: "#59636e",
          600: "#454c54",
          700: "#3d444d",
          800: "#2a313c",
          900: "#151b23",
          950: "#0d1117",
        },
        // Accent (links, selection, focus).
        brand: {
          50: "#ddf4ff",
          100: "#b6e3ff",
          200: "#80ccff",
          300: "#54aeff",
          500: "#218bff",
          600: "#0969da",
          700: "#0550ae",
        },
        sky: {
          50: "#ddf4ff",
          300: "#54aeff",
          700: "#0550ae",
          800: "#0a3069",
          900: "#0c2d6b",
        },
        emerald: {
          50: "#dafbe1",
          300: "#4ac26b",
          400: "#3fb950",
          600: "#1a7f37",
          700: "#116329",
          800: "#044f1e",
          900: "#033a16",
          950: "#04260f",
        },
        amber: {
          50: "#fff8c5",
          300: "#d4a72c",
          400: "#d29922",
          600: "#9a6700",
          700: "#7d4e00",
          800: "#633c01",
          900: "#4d2d00",
          950: "#2e1a00",
        },
        red: {
          50: "#ffebe9",
          200: "#ffaba8",
          300: "#ff8182",
          400: "#f85149",
          600: "#cf222e",
          700: "#a40e26",
          800: "#82071e",
          900: "#5c0d12",
          950: "#3c0b0e",
        },
        // GitHub's Copilot and done purples, used sparingly for Copilot SDK accents.
        done: { 50: "#fbefff", 300: "#c297ff", 500: "#8250df", 600: "#8250df", 700: "#6639ba" },
        gh: {
          header: "var(--bgColor-inset)",
          underline: "var(--underlineNav-borderColor-active)",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", '"Segoe UI"', '"Noto Sans"', "Helvetica", "Arial", "sans-serif", '"Apple Color Emoji"', '"Segoe UI Emoji"'],
        mono: ["ui-monospace", "SFMono-Regular", '"SF Mono"', "Menlo", "Consolas", '"Liberation Mono"', "monospace"],
      },
      borderRadius: {
        lg: "6px",
        xl: "6px",
        "2xl": "12px",
      },
      fontSize: {
        "3xl": ["24px", { lineHeight: "1.5" }],
        "2xl": ["20px", { lineHeight: "1.5" }],
      },
    },
  },
  plugins: [],
};
