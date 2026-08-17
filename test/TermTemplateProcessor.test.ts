import * as RDF from '@rdfjs/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import type { BindingsStream, IQueryEngine } from '@comunica/types';
import type { TermTemplate } from '../lib/TermTemplate';
import { TermTemplateProcessor } from '../lib/TermTemplateProcessor';

describe('TermTemplateProcessor', () => {
  let processor: TermTemplateProcessor;
  let queryEngine: IQueryEngine;

  const DF = new DataFactory();

  const templateSources: string[] = [
    'urn:example:source'
  ];

  beforeEach(() => {
    queryEngine = {
      queryBindings: vi.fn().mockImplementation(() => new ArrayIterator([
        new Map<string, RDF.Term>([
          ['template', DF.namedNode('urn:template')],
          ['pattern', DF.literal('.*')],
          ['text', DF.literal('<p>example</p>')],
          ['target', DF.namedNode('https://localhost/sparql')]
        ])
      ]))
    } as unknown as IQueryEngine;
    processor = new TermTemplateProcessor({
      queryEngine,
      templateSources
    });
  });

  describe('loadTemplates', () => {
    it('retrieves templates using the query engine', async () => {
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
      expect(processor.templates.size).toBe(0);
      await expect(processor.loadTemplates()).resolves.not.toThrow();
      expect(queryEngine.queryBindings).toHaveBeenCalledTimes(1);
      expect(processor.templates.size).toBe(1);
    });

    it('forwards errors from the query engine', async () => {
      vi.spyOn(queryEngine, 'queryBindings').mockRejectedValue(new Error('Error from query engine'));
      await expect(processor.loadTemplates()).rejects.toThrow('Error from query engine');
    });
  });

  describe('findApplicableTemplates', () => {
    it('returns the applicable templates sorted by relevance', async () => {
      const template1 = { id: 'urn:template:1', calculateRelevance: vi.fn().mockReturnValue(1) };
      const template2 = { id: 'urn:template:2', calculateRelevance: vi.fn().mockReturnValue(2) };
      const template3 = { id: 'urn:template:3', calculateRelevance: vi.fn().mockReturnValue(Number.NEGATIVE_INFINITY) };
      processor.templates.set(template1.id, template1 as unknown as TermTemplate);
      processor.templates.set(template2.id, template2 as unknown as TermTemplate);
      processor.templates.set(template3.id, template3 as unknown as TermTemplate);
      expect(template1.calculateRelevance).not.toHaveBeenCalled();
      expect(template2.calculateRelevance).not.toHaveBeenCalled();
      expect(template3.calculateRelevance).not.toHaveBeenCalled();
      expect(processor.findApplicableTemplates('term' as unknown as RDF.Term)).toEqual([
        template2,
        template1
      ]);
      expect(template1.calculateRelevance).toHaveBeenCalledTimes(1);
      expect(template2.calculateRelevance).toHaveBeenCalledTimes(1);
      expect(template3.calculateRelevance).toHaveBeenCalledTimes(1);
    });
  });

  describe('bindingsToRecords', () => {
    it('converts a bindings stream to a record', async () => {
      const bindingsStream = new ArrayIterator([
        new Map<RDF.Variable, RDF.Term>([
          [DF.variable('var1'), DF.literal('value1')]
        ]),
        new Map<RDF.Variable, RDF.Term>([
          [DF.variable('var1'), DF.namedNode('ex:value2')]
        ])
      ]) as unknown as BindingsStream;
      await expect(TermTemplateProcessor.bindingsToRecords(bindingsStream)).resolves.toEqual([
        { var1: DF.literal('value1') },
        { var1: DF.namedNode('ex:value2') }
      ]);
    });
  });

  describe('addBindingsToQuery', () => {
    it('adds bindings as values clause to the query', () => {
      const query = 'SELECT ?s WHERE { ?s ?p ?o }';
      const bindings = [{ o: DF.namedNode('ex:o') }];
      expect(TermTemplateProcessor.addBindingsToQuery(query, bindings)).toBe(
        'SELECT ?s WHERE {\n  ?s ?p ?o .\n  VALUES ?o {\n    <ex:o>\n  }\n}'
      );
    });
  });
});
