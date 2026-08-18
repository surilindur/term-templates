import type * as RDF from '@rdfjs/types';
import { describe, expect, it } from 'vitest';
import { TermTemplate } from '../lib/TermTemplate';

describe('TermTemplate', () => {
  describe('constructor', () => {
    it('should create an instance when all data is present', () => {
      const bindings = new Map([
        ['template', { value: 'urn:template' }],
        ['pattern', { value: '.*' }],
        ['text', { value: '<p>example</p>' }],
        ['target', { value: 'https://localhost/sparql' }]
      ]) as unknown as RDF.Bindings;
      expect(new TermTemplate(bindings)).toBeInstanceOf(TermTemplate);
    });

    it('should throw on bad pattern', () => {
      const bindings = new Map([
        ['template', { value: 'urn:template' }],
        ['pattern', { value: '[[[' }],
        ['text', { value: '<p>example</p>' }],
        ['target', { value: 'https://localhost/sparql' }]
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow();
    });

    it('should throw on missing identifier', () => {
      const bindings = new Map([
        ['pattern', { value: '.*' }],
        ['text', { value: '<p>example</p>' }],
        ['target', { value: 'https://localhost/sparql' }]
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow('undefined');
    });

    it('should throw on missing pattern', () => {
      const bindings = new Map([
        ['template', { value: 'urn:template' }],
        ['text', { value: '<p>example</p>' }],
        ['target', { value: 'https://localhost/sparql' }]
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow('undefined');
    });

    it('should throw on missing text', () => {
      const bindings = new Map([
        ['template', { value: 'urn:template' }],
        ['pattern', { value: '.*' }],
        ['target', { value: 'https://localhost/sparql' }]
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow('undefined');
    });

    it('should throw on missing target', () => {
      const bindings = new Map([
        ['template', { value: 'urn:template' }],
        ['pattern', { value: '.*' }],
        ['text', { value: '<p>example</p>' }]
      ]) as unknown as RDF.Bindings;
      expect(() => new TermTemplate(bindings)).toThrow('undefined');
    });
  });

  describe('calculateRelevance', () => {
    const bindings = new Map([
      ['template', { value: 'urn:template' }],
      ['pattern', { value: '^AB' }],
      ['text', { value: '<p>example</p>' }],
      ['target', { value: 'https://localhost/sparql' }]
    ]) as unknown as RDF.Bindings;

    const template = new TermTemplate(bindings);

    it('should return negative infinity for non-matching values', () => {
      const term = { value: 'B' } as RDF.Term;
      expect(template.calculateRelevance(term)).toBe(Number.NEGATIVE_INFINITY);
    });

    it('should return match length for matching values', () => {
      const term = { value: 'ABCD' } as RDF.Term;
      expect(template.calculateRelevance(term)).toBe(2);
    });
  });
});
