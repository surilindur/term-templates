import * as RDF from '@rdfjs/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import type { IQueryEngine } from '@comunica/types';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { TermTemplate } from '../lib/TermTemplate';
import { TermTemplateProcessor } from '../lib/TermTemplateProcessor';
import { ITermTemplateContext } from '../lib';

describe('TermTemplateProcessor', () => {
  let processor: TermTemplateProcessor;
  let queryEngine: IQueryEngine;

  const dataFactory = new DataFactory();
  const algebraFactory = new AlgebraFactory(dataFactory);

  const templateSources: string[] = [
    'urn:example:source'
  ];

  beforeEach(() => {
    queryEngine = {
      queryBindings: vi.fn().mockImplementation(() => new ArrayIterator([
        new Map<string, RDF.Term>([
          ['template', dataFactory.namedNode('urn:template')],
          ['pattern', dataFactory.literal('.*')],
          ['text', dataFactory.literal('<p>example</p>')],
          ['target', dataFactory.namedNode('https://localhost/sparql')]
        ])
      ]))
    } as unknown as IQueryEngine;
    processor = new TermTemplateProcessor({
      queryEngine,
      dataFactory,
      algebraFactory,
      templateSources,
      batchWindow: 200,
      queryIdentifierVariable: 'query'
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
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
    it('converts a bindings array to a record array', () => {
      const bindings = [
        new Map<RDF.Variable, RDF.Term>([
          [dataFactory.variable('var1'), dataFactory.literal('value1')]
        ]),
        new Map<RDF.Variable, RDF.Term>([
          [dataFactory.variable('var1'), dataFactory.namedNode('ex:value2')]
        ])
      ] as unknown as RDF.Bindings[];
      expect(TermTemplateProcessor.bindingsToRecords(bindings)).toEqual([
        { var1: dataFactory.literal('value1') },
        { var1: dataFactory.namedNode('ex:value2') }
      ]);
    });
  });

  describe('parseOperation', () => {
    it('parses an operation', () => {
      const query = '';
      expect(TermTemplateProcessor.parseOperation(query)).toEqual({ type: 'nop' });
    });
  });

  describe('serializeOperation', () => {
    it('serializes an operation', () => {
      const operation = algebraFactory.createNop();
      expect(TermTemplateProcessor.serializeOperation(operation)).toBe('');
    });
  });

  describe('addBindingsToQuery', () => {
    it('adds bindings as values clause to the query', () => {
      const query = 'SELECT ?s WHERE { ?s ?p ?o }';
      const bindings = [{ o: dataFactory.namedNode('ex:o') }];
      expect(processor.addBindings(query, bindings)).toBe(
        'SELECT ?s WHERE {\n  ?s ?p ?o .\n  VALUES ?o {\n    <ex:o>\n  }\n}'
      );
    });
  });

  describe('visualiseTerm', () => {
    it('returns direct serialization without applicable templates', async () => {
      vi.spyOn(processor, 'findApplicableTemplates').mockReturnValue([]);
      await expect(processor.visualiseTerm({ value: 'abc' } as unknown as RDF.Term)).resolves.toBe(
        '<pre>{\n  "value": "abc"\n}</pre>'
      );
      expect(processor.findApplicableTemplates).toHaveBeenCalledTimes(1);
    });

    it('visualises the term recursively', async () => {
      vi.spyOn(processor, 'findApplicableTemplates').mockReturnValue([{ text: 'template content' } as unknown as TermTemplate]);
      vi.spyOn(processor, 'askBatched').mockResolvedValue('ask result' as unknown as boolean);
      vi.spyOn(processor, 'selectBatched').mockResolvedValue(['select bindings' as unknown as RDF.Bindings]);
      vi.spyOn(TermTemplateProcessor, 'bindingsToRecords').mockResolvedValue('select result' as unknown as Record<string, RDF.NamedNode | RDF.Literal>[]);
      vi.spyOn(TermTemplateProcessor.eta, 'renderStringAsync').mockImplementation(async (template: string, data: object): Promise<string> => {
        expect(template).toBe('template content');
        expect((data as ITermTemplateContext).term).toBeOneOf(['term to visualise', 'recursive term']);
        if ((data as ITermTemplateContext).term as unknown as string === 'term to visualise') {
          await expect((data as ITermTemplateContext).queryAsk('', [])).resolves.toBe('ask result');
          await expect((data as ITermTemplateContext).querySelect('', [])).resolves.toBe('select result');
          await expect((data as ITermTemplateContext).visualiseTerm('recursive term' as unknown as RDF.Term)).resolves.toBe('recursive output html');
          return 'output html';
        } else {
          return 'recursive output html';
        }
      });
      await expect(processor.visualiseTerm('term to visualise' as unknown as RDF.Term)).resolves.toBe('output html');
      expect(processor.findApplicableTemplates).toHaveBeenCalledTimes(2);
      expect(processor.askBatched).toHaveBeenCalledTimes(1);
      expect(processor.selectBatched).toHaveBeenCalledTimes(1);
      expect(TermTemplateProcessor.bindingsToRecords).toHaveBeenCalledTimes(1);
      expect(TermTemplateProcessor.eta.renderStringAsync).toHaveBeenCalledTimes(2);
    });

    it('visualises errors during template rendering', async () => {
      vi.spyOn(processor, 'findApplicableTemplates').mockReturnValue([{ text: 'template content' } as unknown as TermTemplate]);
      vi.spyOn(processor, 'askBatched').mockResolvedValue('ask result' as unknown as boolean);
      vi.spyOn(processor, 'selectBatched').mockResolvedValue(['select bindings' as unknown as RDF.Bindings]);
      vi.spyOn(TermTemplateProcessor, 'bindingsToRecords').mockResolvedValue('select result' as unknown as Record<string, RDF.NamedNode | RDF.Literal>[]);
      vi.spyOn(TermTemplateProcessor.eta, 'renderStringAsync').mockRejectedValue(new Error('Template rendering error'));
      await expect(processor.visualiseTerm('term to visualise' as unknown as RDF.Term)).resolves.toBe(
        '<pre class="error">Error: Template rendering error</pre>'
      );
      expect(processor.findApplicableTemplates).toHaveBeenCalledTimes(1);
      expect(processor.askBatched).not.toHaveBeenCalled();
      expect(processor.selectBatched).not.toHaveBeenCalled();
      expect(TermTemplateProcessor.bindingsToRecords).not.toHaveBeenCalled();
      expect(TermTemplateProcessor.eta.renderStringAsync).toHaveBeenCalledTimes(1);
    });
  });
});
