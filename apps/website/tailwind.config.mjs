export default {
  content: ["./src/**/*.{astro,html,js,ts,md,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: "#131313",
        "surface-container": "#201f1f",
        primary: "#57f1db",
        secondary: "#ffe2ab",
        muted: "#bacac5",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Space Grotesk", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        DEFAULT: "2px",
        lg: "4px",
      },
    },
  },
  plugins: [],
};
