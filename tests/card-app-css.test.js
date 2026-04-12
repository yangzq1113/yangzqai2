import { describe, test, expect } from '@jest/globals';
import { scopeCSS } from '../public/scripts/extensions/card-app/loader.js';

const C = '#card-app-container';

describe('scopeCSS', () => {
    describe('basic selector scoping', () => {
        test('should prefix simple class selector', () => {
            const result = scopeCSS('.foo { color: red; }');
            expect(result).toContain(`${C} .foo`);
            expect(result).toContain('color: red;');
        });

        test('should prefix simple element selector', () => {
            const result = scopeCSS('h1 { font-size: 24px; }');
            expect(result).toContain(`${C} h1`);
        });

        test('should prefix ID selector', () => {
            const result = scopeCSS('#main { display: flex; }');
            expect(result).toContain(`${C} #main`);
        });

        test('should prefix compound selector', () => {
            const result = scopeCSS('div.container > p { margin: 0; }');
            expect(result).toContain(`${C} div.container > p`);
        });

        test('should handle multiple selectors (comma-separated)', () => {
            const result = scopeCSS('h1, h2, h3 { font-weight: bold; }');
            expect(result).toContain(`${C} h1`);
            expect(result).toContain(`${C} h2`);
            expect(result).toContain(`${C} h3`);
        });
    });

    describe('global selector replacement', () => {
        test('should replace body with container selector', () => {
            const result = scopeCSS('body { background: black; }');
            expect(result).toContain(`${C}`);
            expect(result).not.toContain('body');
        });

        test('should replace html with container selector', () => {
            const result = scopeCSS('html { font-size: 16px; }');
            expect(result).toContain(`${C}`);
            expect(result).not.toContain('html');
        });

        test('should replace :root with container selector', () => {
            const result = scopeCSS(':root { --color: red; }');
            expect(result).toContain(`${C}`);
        });

        test('should replace body followed by descendant', () => {
            const result = scopeCSS('body .content { padding: 10px; }');
            expect(result).toContain(`${C} .content`);
        });

        test('should scope universal selector', () => {
            const result = scopeCSS('* { box-sizing: border-box; }');
            expect(result).toContain(`${C} *`);
        });
    });

    describe('already scoped selectors', () => {
        test('should not double-prefix already scoped selector', () => {
            const input = `${C} .foo { color: red; }`;
            const result = scopeCSS(input);
            // Should not have double container prefix
            expect(result).not.toContain(`${C} ${C}`);
        });
    });

    describe('@-rules handling', () => {
        test('should scope selectors inside @media', () => {
            const input = '@media (max-width: 768px) { .mobile { display: block; } }';
            const result = scopeCSS(input);
            expect(result).toContain('@media (max-width: 768px)');
            expect(result).toContain(`${C} .mobile`);
        });

        test('should NOT modify @keyframes content', () => {
            const input = '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }';
            const result = scopeCSS(input);
            expect(result).toContain('@keyframes fadeIn');
            expect(result).toContain('from { opacity: 0; }');
            expect(result).toContain('to { opacity: 1; }');
            // Should NOT have container prefix inside keyframes
            expect(result).not.toContain(`${C} from`);
            expect(result).not.toContain(`${C} to`);
        });

        test('should NOT modify @font-face', () => {
            const input = '@font-face { font-family: "MyFont"; src: url("font.woff2"); }';
            const result = scopeCSS(input);
            expect(result).toContain('@font-face');
            expect(result).toContain('font-family: "MyFont"');
        });

        test('should handle nested @media with multiple rules', () => {
            const input = '@media screen { .a { color: red; } .b { color: blue; } }';
            const result = scopeCSS(input);
            expect(result).toContain(`${C} .a`);
            expect(result).toContain(`${C} .b`);
        });

        test('should handle @supports', () => {
            const input = '@supports (display: grid) { .grid { display: grid; } }';
            const result = scopeCSS(input);
            expect(result).toContain('@supports (display: grid)');
            expect(result).toContain(`${C} .grid`);
        });
    });

    describe('comments', () => {
        test('should remove CSS comments', () => {
            const input = '/* This is a comment */ .foo { color: red; }';
            const result = scopeCSS(input);
            expect(result).not.toContain('This is a comment');
            expect(result).toContain(`${C} .foo`);
        });

        test('should handle multi-line comments', () => {
            const input = `
                /* 
                 * Multi-line comment
                 */
                .bar { display: flex; }
            `;
            const result = scopeCSS(input);
            expect(result).not.toContain('Multi-line comment');
            expect(result).toContain(`${C} .bar`);
        });
    });

    describe('edge cases', () => {
        test('should handle empty string', () => {
            expect(scopeCSS('')).toBe('');
        });

        test('should handle whitespace only', () => {
            const result = scopeCSS('   \n\t  ');
            expect(result.trim()).toBe('');
        });

        test('should handle multiple rules', () => {
            const input = '.a { color: red; } .b { color: blue; } .c { color: green; }';
            const result = scopeCSS(input);
            expect(result).toContain(`${C} .a`);
            expect(result).toContain(`${C} .b`);
            expect(result).toContain(`${C} .c`);
        });

        test('should preserve property values', () => {
            const input = '.foo { background: url("image.png"); font-family: "Arial", sans-serif; }';
            const result = scopeCSS(input);
            expect(result).toContain('url("image.png")');
            expect(result).toContain('font-family: "Arial", sans-serif;');
        });
    });
});
