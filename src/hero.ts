import { heroui } from "@heroui/react";
export default heroui({
  defaultTheme: "dark",
  themes: {
    dark: {
      colors: {
        background: "#101112",
        foreground: "#e8e8e8",
        primary: { DEFAULT: "#ededed", foreground: "#151515" },
        focus: "#a3a3a3",
        content1: "#191a1c",
        content2: "#222326",
        content3: "#2b2c2f",
        content4: "#36373a",
        default: {
          50: "#151618",
          100: "#202124",
          200: "#2b2c2f",
          300: "#3d3e42",
          400: "#696a70",
          500: "#8b8c91",
          600: "#afb0b4",
          700: "#cdced1",
          800: "#e1e2e4",
          900: "#f4f4f5",
          DEFAULT: "#2b2c2f",
          foreground: "#ededed",
        },
      },
    },
  },
});
