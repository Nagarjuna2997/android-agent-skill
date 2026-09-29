import parser from "@typescript-eslint/parser";
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-constant-condition": "error",
      "no-unreachable": "error",
      "no-duplicate-case": "error",
      "no-debugger": "error",
      "no-unsafe-finally": "error",
    },
  },
];
