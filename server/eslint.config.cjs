const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'coverage/**',
            'dist/**',
            'public/js/libs/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.{js,ts,cjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'commonjs'
            },
            globals: {
                ...globals.node
            }
        },
        plugins: {
            '@typescript-eslint': tseslint
        },
        rules: {
            // TypeScript already checks undefined names; the JS rule false-positives on types
            // and on names that collide with DOM/Node globals (Event, crypto, …)
            'no-undef': 'off',
            'no-redeclare': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }]
        }
    },
    {
        files: ['public/**/*.{js,ts}'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                ...globals.browser
            }
        }
    }
];
