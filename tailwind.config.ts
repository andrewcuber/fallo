import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Space-inspired palette
        space: {
          DEFAULT: "#080D19",
          light: "#101B35",
          lighter: "#1A2A4A",
        },
        midnight: {
          DEFAULT: "#101B35",
          dark: "#080D19",
        },
        "slate-blue": {
          DEFAULT: "#24334F",
          light: "#3A4F6E",
        },
        electric: {
          DEFAULT: "#4D9FFF",
          dark: "#3A7FE0",
          light: "#7BB8FF",
        },
        cyan: {
          DEFAULT: "#62D5E8",
          dark: "#4AB8CC",
          light: "#8EE3F0",
        },
        "accent-red": {
          DEFAULT: "#E34B5B",
          dark: "#C43A4A",
          light: "#F06B7A",
        },
        offwhite: {
          DEFAULT: "#F3F5FA",
          dark: "#E8EBF3",
        },
        // Legacy brand colors (kept for reference during transition)
        forest: {
          DEFAULT: "#2A543F",
          dark: "#193B2E",
          light: "#3A6A50",
        },
        cream: {
          DEFAULT: "#F6F4EC",
          dark: "#E8DFC9",
        },
        sand: {
          DEFAULT: "#E8DFC9",
          dark: "#D4C9AD",
        },
        brown: {
          DEFAULT: "#B49A75",
          dark: "#8C7352",
        },
        mint: {
          DEFAULT: "#DCE9DC",
          dark: "#B8D4B8",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        serif: ["var(--font-lora)", "Georgia", "serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};

export default config;
