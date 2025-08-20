import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },
  prettierRecommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
