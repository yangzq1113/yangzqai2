import { describe, test, expect } from '@jest/globals';
import { CHAT_COMPLETION_SOURCES } from '../src/constants';
import { deepMerge, findNameMatch, flattenSchema, normalizeLookupText } from '../src/util';

describe('flattenSchema', () => {
    test('should return the schema if it is not an object', () => {
        const schema = 'it is not an object';
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toBe(schema);
    });

    test('should handle schema with $defs and $ref', () => {
        const schema = {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $defs: {
                a: { type: 'string' },
                b: {
                    type: 'object',
                    properties: {
                        c: { $ref: '#/$defs/a' },
                    },
                },
            },
            properties: {
                d: { $ref: '#/$defs/b' },
            },
        };
        const expected = {
            properties: {
                d: {
                    type: 'object',
                    properties: {
                        c: { type: 'string' },
                    },
                },
            },
        };
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toEqual(expected);
    });

    test('should filter unsupported properties for Google API schema', () => {
        const schema = {
            $defs: {
                a: {
                    type: 'string',
                    default: 'test',
                },
            },
            type: 'object',
            properties: {
                b: { $ref: '#/$defs/a' },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        const expected = {
            type: 'object',
            properties: {
                b: {
                    type: 'string',
                },
                c: { type: 'number' },
            },
        };
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toEqual(expected);
    });

    test('should not filter properties for non-Google API schema', () => {
        const schema = {
            $defs: {
                a: {
                    type: 'string',
                    default: 'test',
                },
            },
            type: 'object',
            properties: {
                b: { $ref: '#/$defs/a' },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        const expected = {
            type: 'object',
            properties: {
                b: {
                    type: 'string',
                    default: 'test',
                },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        expect(flattenSchema(schema, 'some-other-api')).toEqual(expected);
    });
});

describe('lookup name normalization', () => {
    test('should ignore emoji variation selectors when resolving names', () => {
        expect(normalizeLookupText('❤️World')).toBe('❤World');
        expect(findNameMatch(['❤️World'], '❤World')).toBe('❤️World');
        expect(findNameMatch(['⭐️Preset'], '⭐Preset')).toBe('⭐️Preset');
    });

    test('should prefer exact matches before tolerant matches', () => {
        const names = ['❤World', '❤️World'];
        expect(findNameMatch(names, '❤World')).toBe('❤World');
        expect(findNameMatch(names, '❤️World')).toBe('❤️World');
    });
});

describe('deepMerge', () => {
    test('should preserve explicit null assignments for nested keys', () => {
        const result = deepMerge(
            { data: { extensions: { luker: { chat_completion_preset: { name: 'Old' } } } } },
            { data: { extensions: { luker: { chat_completion_preset: null } } } },
        );

        expect(result).toEqual({
            data: {
                extensions: {
                    luker: {
                        chat_completion_preset: null,
                    },
                },
            },
        });
    });

    test('should replace null targets with incoming objects', () => {
        const result = deepMerge(
            { data: { extensions: { luker: { chat_completion_preset: null } } } },
            { data: { extensions: { luker: { chat_completion_preset: { name: 'New' } } } } },
        );

        expect(result).toEqual({
            data: {
                extensions: {
                    luker: {
                        chat_completion_preset: {
                            name: 'New',
                        },
                    },
                },
            },
        });
    });
});
