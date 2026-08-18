import * as RDF from '@rdfjs/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import type { BindingsStream, IQueryEngine } from '@comunica/types';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { TermTemplate } from '../lib/TermTemplate';
import { QueryBuffer, TermTemplateProcessor } from '../lib/TermTemplateProcessor';
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
    vi.useRealTimers();
  });

  describe('loadTemplates', () => {
    it('retrieves templates using the query engine', async () => {
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
      expect(processor.templates.size).toBe(0);
      await expect(processor.loadTemplates()).resolves.not.toThrow();
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
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
      expect(template1.calculateRelevance).toHaveBeenCalledOnce();
      expect(template2.calculateRelevance).toHaveBeenCalledOnce();
      expect(template3.calculateRelevance).toHaveBeenCalledOnce();
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

  describe('bindingsToValues', () => {
    it('converts bindings array to values clause', () => {
      const bindings = [{ var1: dataFactory.literal('value1') }];
      expect(processor.bindingsToValues(bindings)).toEqual(algebraFactory.createValues(
        [dataFactory.variable('var1')],
        bindings
      ));
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

  describe('visualiseTerm', () => {
    it('returns direct serialization without applicable templates', async () => {
      vi.spyOn(processor, 'findApplicableTemplates').mockReturnValue([]);
      await expect(processor.visualiseTerm({ value: 'abc' } as unknown as RDF.Term)).resolves.toBe(
        '<pre>{\n  "value": "abc"\n}</pre>'
      );
      expect(processor.findApplicableTemplates).toHaveBeenCalledOnce();
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
      expect(processor.askBatched).toHaveBeenCalledOnce();
      expect(processor.selectBatched).toHaveBeenCalledOnce();
      expect(TermTemplateProcessor.bindingsToRecords).toHaveBeenCalledOnce();
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
      expect(processor.findApplicableTemplates).toHaveBeenCalledOnce();
      expect(processor.askBatched).not.toHaveBeenCalled();
      expect(processor.selectBatched).not.toHaveBeenCalled();
      expect(TermTemplateProcessor.bindingsToRecords).not.toHaveBeenCalled();
      expect(TermTemplateProcessor.eta.renderStringAsync).toHaveBeenCalledOnce();
    });
  });

  describe('generateQueryIdentifier', () => {
    it('returns the same identifiers for the same query', () => {
      expect(processor.generateQueryIdentifier('query1', [], []))
        .toEqual(processor.generateQueryIdentifier('query1', [], []));
    });

    it('returns the same identifiers for the same query with same bindings', () => {
      expect(processor.generateQueryIdentifier('query1', [], [{ var1: dataFactory.literal('value1') }, { var1: dataFactory.literal('value2') }]))
        .toEqual(processor.generateQueryIdentifier('query1', [], [{ var1: dataFactory.literal('value2') }, { var1: dataFactory.literal('value1') }]));
    });

    it('returns different identifiers for different queries', () => {
      expect(processor.generateQueryIdentifier('query1', [], []))
        .not.toEqual(processor.generateQueryIdentifier('query2', [], []));
    });

    it('returns different identifiers for the same query with different bindings', () => {
      expect(processor.generateQueryIdentifier('query1', [], []))
        .not.toEqual(processor.generateQueryIdentifier('query1', [], [{ var1: dataFactory.literal('value1') }]));
    });

    it('returns different identifiers for the same query with different sources', () => {
      expect(processor.generateQueryIdentifier('query1', ['source1'], []))
        .not.toEqual(processor.generateQueryIdentifier('query1', ['source2'], []));
    });
  });

  describe('generateQueryBatchIdentifier', () => {
    it('returns the same identifiers for the same query', () => {
      expect(processor.generateQueryBatchIdentifier('query1', [], []))
        .toEqual(processor.generateQueryBatchIdentifier('query1', [], []));
    });

    it('returns the same identifiers for the same query with different bindings', () => {
      expect(processor.generateQueryBatchIdentifier('query1', [], [{ var1: dataFactory.literal('value1') }]))
        .toEqual(processor.generateQueryBatchIdentifier('query1', [], [{ var1: dataFactory.literal('value2') }]));
    });

    it('returns different identifiers for different queries', () => {
      expect(processor.generateQueryBatchIdentifier('query1', [], []))
        .not.toEqual(processor.generateQueryBatchIdentifier('query2', [], []));
    });

    it('returns different identifiers for the same query with different sources', () => {
      expect(processor.generateQueryBatchIdentifier('query1', ['source1'], []))
        .not.toEqual(processor.generateQueryBatchIdentifier('query1', ['source2'], []));
    });
  });

  describe('askBatched', () => {
    it('invokes batched execution', async () => {
      vi.spyOn(processor, 'executeBatched').mockResolvedValue('result');
      expect(processor.executeBatched).not.toHaveBeenCalled();
      await expect(processor.askBatched('query', [], [])).resolves.toBe('result');
      expect(processor.executeBatched).toHaveBeenCalledOnce();
    });
  });

  describe('selectBatched', () => {
    it('invokes batched execution', async () => {
      vi.spyOn(processor, 'executeBatched').mockResolvedValue('result');
      expect(processor.executeBatched).not.toHaveBeenCalled();
      await expect(processor.selectBatched('query', [], [])).resolves.toBe('result');
      expect(processor.executeBatched).toHaveBeenCalledOnce();
    });
  });

  describe('selectAll', () => {
    it('executes a select query and converts output to array', async () => {
      vi.spyOn(queryEngine, 'queryBindings').mockResolvedValue(new ArrayIterator([
        'bindings1',
        'bindings2'
      ]) as unknown as BindingsStream);
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
      await expect(processor.selectAll('query', [])).resolves.toEqual([
        'bindings1',
        'bindings2'
      ]);
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
    });
  });

  describe('executeBatched', () => {
    it('executes the query and maps result back to original one', async () => {
      vi.useFakeTimers();
      const buffer: QueryBuffer<boolean> = {};
      const query = 'ASK WHERE { ?s ?p ?o }';
      const sources = ['urn:source1', 'urn:source2'];
      const actualResults: Record<string, Promise<boolean>> = {};
      const expectedResults: Record<string, boolean> = {};
      const executor = vi.fn().mockImplementation((batchIdentifier: RDF.NamedNode) => {
        for (const [queryIdentifier, resolutions] of Object.entries(buffer[batchIdentifier.value].resolutions)) {
          for (const resolution of resolutions) {
            resolution(expectedResults[queryIdentifier]);
          }
        }
        delete buffer[batchIdentifier.value];
      });
      expect(buffer).toEqual({});
      for (const i of [0, 0, 1, 2, 2, 3, 4, 5, 6]) {
        const bindings = [{ o: dataFactory.namedNode(`o${i}`) }];
        const queryIdentifier = processor.generateQueryIdentifier(query, sources, bindings).value;
        expectedResults[queryIdentifier] = Math.random() < 0.5 ? true : false;
        actualResults[queryIdentifier] = processor.executeBatched(query, sources, bindings, buffer, executor);
      }
      vi.runAllTimers();
      for (const [queryIdentifier, expectedResult] of Object.entries(expectedResults)) {
        await expect(actualResults[queryIdentifier]).resolves.toBe(expectedResult);
      }
      expect(buffer).toEqual({});
    });
  });
});
