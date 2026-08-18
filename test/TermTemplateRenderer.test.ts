import * as RDF from '@rdfjs/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import type { BindingsStream, IQueryEngine } from '@comunica/types';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { TermTemplate } from '../lib/TermTemplate';
import { QueryBuffer, TermTemplateRenderer } from '../lib/TermTemplateRenderer';
import type { ITermTemplateContext } from '../lib/TermTemplateContext';

describe('TermTemplateRenderer', () => {
  let renderer: TermTemplateRenderer;
  let queryEngine: IQueryEngine;

  const dataFactory = new DataFactory();
  const algebraFactory = new AlgebraFactory(dataFactory);

  beforeEach(() => {
    queryEngine = {
      queryBindings: vi.fn().mockResolvedValue(new ArrayIterator([
        new Map<string, RDF.Term>([
          ['template', dataFactory.namedNode('urn:template')],
          ['pattern', dataFactory.literal('.*')],
          ['text', dataFactory.literal('<p>example</p>')],
          ['priority', dataFactory.literal('10', dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'))],
          ['target', dataFactory.namedNode('https://localhost/sparql')]
        ]),
        new Map<string, RDF.Term>([
          ['template', dataFactory.namedNode('urn:template')],
          ['pattern', dataFactory.literal('.*')],
          ['text', dataFactory.literal('<p>example with lower priority</p>')],
          ['priority', dataFactory.literal('0', dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'))],
          ['target', dataFactory.namedNode('https://localhost/sparql')]
        ])
      ]))
    } as unknown as IQueryEngine;
    renderer = new TermTemplateRenderer({
      queryEngine,
      dataFactory,
      algebraFactory,
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
      expect(renderer.templates.size).toBe(0);
      await expect(renderer.loadTemplates([])).resolves.not.toThrow();
      expect(queryEngine.queryBindings).toHaveBeenCalledOnce();
      expect(renderer.templates.size).toBe(1);
    });

    it('forwards errors from the query engine', async () => {
      vi.spyOn(queryEngine, 'queryBindings').mockRejectedValue(new Error('Error from query engine'));
      await expect(renderer.loadTemplates([])).rejects.toThrow('Error from query engine');
    });
  });

  describe('findApplicableTemplates', () => {
    it('returns the applicable templates sorted by relevance', async () => {
      const template1 = { id: 'urn:template:1', calculateRelevance: vi.fn().mockReturnValue(1) };
      const template2 = { id: 'urn:template:2', calculateRelevance: vi.fn().mockReturnValue(2) };
      const template3 = { id: 'urn:template:3', calculateRelevance: vi.fn().mockReturnValue(Number.NEGATIVE_INFINITY) };
      renderer.templates.set(template1.id, template1 as unknown as TermTemplate);
      renderer.templates.set(template2.id, template2 as unknown as TermTemplate);
      renderer.templates.set(template3.id, template3 as unknown as TermTemplate);
      expect(template1.calculateRelevance).not.toHaveBeenCalled();
      expect(template2.calculateRelevance).not.toHaveBeenCalled();
      expect(template3.calculateRelevance).not.toHaveBeenCalled();
      expect(renderer.findApplicableTemplates('term' as unknown as RDF.Term)).toEqual([
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
      expect(TermTemplateRenderer.bindingsToRecords(bindings)).toEqual([
        { var1: dataFactory.literal('value1') },
        { var1: dataFactory.namedNode('ex:value2') }
      ]);
    });
  });

  describe('bindingsToValues', () => {
    it('converts bindings array to values clause', () => {
      const bindings = [{ var1: dataFactory.literal('value1') }];
      expect(renderer.bindingsToValues(bindings)).toEqual(algebraFactory.createValues(
        [dataFactory.variable('var1')],
        bindings
      ));
    });
  });

  describe('parseOperation', () => {
    it('parses an operation', () => {
      const query = '';
      expect(TermTemplateRenderer.parseOperation(query)).toEqual({ type: 'nop' });
    });
  });

  describe('serializeOperation', () => {
    it('serializes an operation', () => {
      const operation = algebraFactory.createNop();
      expect(TermTemplateRenderer.serializeOperation(operation)).toBe('');
    });
  });

  describe('visualiseTerm', () => {
    it('returns direct serialization without applicable templates', async () => {
      vi.spyOn(renderer, 'findApplicableTemplates').mockReturnValue([]);
      await expect(renderer.visualiseTerm({ value: 'abc' } as unknown as RDF.Term)).resolves.toBe(
        '<pre>{\n  "value": "abc"\n}</pre>'
      );
      expect(renderer.findApplicableTemplates).toHaveBeenCalledOnce();
    });

    it('visualises the term recursively', async () => {
      vi.spyOn(renderer, 'findApplicableTemplates').mockReturnValue([{ text: 'template content' } as unknown as TermTemplate]);
      vi.spyOn(renderer, 'askBatched').mockResolvedValue('ask result' as unknown as boolean);
      vi.spyOn(renderer, 'selectBatched').mockResolvedValue(['select bindings' as unknown as RDF.Bindings]);
      vi.spyOn(TermTemplateRenderer, 'bindingsToRecords').mockResolvedValue('select result' as unknown as Record<string, RDF.NamedNode | RDF.Literal>[]);
      vi.spyOn(TermTemplateRenderer.eta, 'renderStringAsync').mockImplementation(async (template: string, data: object): Promise<string> => {
        expect(template).toBe('template content');
        expect((data as ITermTemplateContext).term).toBeOneOf(['term to visualise', 'recursive term']);
        if ((data as ITermTemplateContext).term as unknown as string === 'term to visualise') {
          // Call with and without bindings array
          await expect((data as ITermTemplateContext).queryAsk('', [])).resolves.toBe('ask result');
          await expect((data as ITermTemplateContext).queryAsk('')).resolves.toBe('ask result');
          // Call with and without bindings array
          await expect((data as ITermTemplateContext).querySelect('', [])).resolves.toBe('select result');
          await expect((data as ITermTemplateContext).querySelect('')).resolves.toBe('select result');
          // Call once, since there is no flexibility in parameters
          await expect((data as ITermTemplateContext).visualiseTerm('recursive term' as unknown as RDF.Term)).resolves.toBe('recursive output html');
          return 'output html';
        } else {
          return 'recursive output html';
        }
      });
      await expect(renderer.visualiseTerm('term to visualise' as unknown as RDF.Term)).resolves.toBe('output html');
      expect(renderer.findApplicableTemplates).toHaveBeenCalledTimes(2);
      expect(renderer.askBatched).toHaveBeenCalledTimes(2);
      expect(renderer.selectBatched).toHaveBeenCalledTimes(2);
      expect(TermTemplateRenderer.bindingsToRecords).toHaveBeenCalledTimes(2);
      expect(TermTemplateRenderer.eta.renderStringAsync).toHaveBeenCalledTimes(2);
    });

    it('visualises errors during template rendering', async () => {
      vi.spyOn(renderer, 'findApplicableTemplates').mockReturnValue([{ text: 'template content' } as unknown as TermTemplate]);
      vi.spyOn(renderer, 'askBatched').mockResolvedValue('ask result' as unknown as boolean);
      vi.spyOn(renderer, 'selectBatched').mockResolvedValue(['select bindings' as unknown as RDF.Bindings]);
      vi.spyOn(TermTemplateRenderer, 'bindingsToRecords').mockResolvedValue('select result' as unknown as Record<string, RDF.NamedNode | RDF.Literal>[]);
      vi.spyOn(TermTemplateRenderer.eta, 'renderStringAsync').mockRejectedValue(new Error('Template rendering error'));
      await expect(renderer.visualiseTerm('term to visualise' as unknown as RDF.Term)).resolves.toBe(
        '<pre class="error">Error: Template rendering error</pre>'
      );
      expect(renderer.findApplicableTemplates).toHaveBeenCalledOnce();
      expect(renderer.askBatched).not.toHaveBeenCalled();
      expect(renderer.selectBatched).not.toHaveBeenCalled();
      expect(TermTemplateRenderer.bindingsToRecords).not.toHaveBeenCalled();
      expect(TermTemplateRenderer.eta.renderStringAsync).toHaveBeenCalledOnce();
    });
  });

  describe('generateQueryIdentifier', () => {
    it('returns the same identifiers for the same query', () => {
      expect(renderer.generateQueryIdentifier('query1', [], []))
        .toEqual(renderer.generateQueryIdentifier('query1', [], []));
    });

    it('returns the same identifiers for the same query with same bindings', () => {
      expect(renderer.generateQueryIdentifier(
        'query1',
        [],
        [
          { var1: dataFactory.literal('value1'), var2: dataFactory.literal('value2') },
          { var2: dataFactory.literal('value2'), var1: dataFactory.literal('value1') }
        ]))
        .toEqual(renderer.generateQueryIdentifier(
          'query1',
          [],
          [
            { var1: dataFactory.literal('value1'), var2: dataFactory.literal('value2') },
            { var2: dataFactory.literal('value2'), var1: dataFactory.literal('value1') }
          ]
        ));
    });

    it('returns different identifiers for different queries', () => {
      expect(renderer.generateQueryIdentifier('query1', [], []))
        .not.toEqual(renderer.generateQueryIdentifier('query2', [], []));
    });

    it('returns different identifiers for the same query with different bindings', () => {
      expect(renderer.generateQueryIdentifier('query1', [], []))
        .not.toEqual(renderer.generateQueryIdentifier('query1', [], [{ var1: dataFactory.literal('value1') }]));
    });

    it('returns different identifiers for the same query with different sources', () => {
      expect(renderer.generateQueryIdentifier('query1', ['source1'], []))
        .not.toEqual(renderer.generateQueryIdentifier('query1', ['source2'], []));
    });
  });

  describe('generateQueryBatchIdentifier', () => {
    it('returns the same identifiers for the same query', () => {
      expect(renderer.generateQueryBatchIdentifier('query1', [], []))
        .toEqual(renderer.generateQueryBatchIdentifier('query1', [], []));
    });

    it('returns the same identifiers for the same query with different bindings', () => {
      expect(renderer.generateQueryBatchIdentifier('query1', [], [{ var1: dataFactory.literal('value1') }]))
        .toEqual(renderer.generateQueryBatchIdentifier('query1', [], [{ var1: dataFactory.literal('value2') }]));
    });

    it('returns different identifiers for different queries', () => {
      expect(renderer.generateQueryBatchIdentifier('query1', [], []))
        .not.toEqual(renderer.generateQueryBatchIdentifier('query2', [], []));
    });

    it('returns different identifiers for the same query with different sources', () => {
      expect(renderer.generateQueryBatchIdentifier('query1', ['source1'], []))
        .not.toEqual(renderer.generateQueryBatchIdentifier('query1', ['source2'], []));
    });
  });

  describe('askBatched', () => {
    it('invokes batched execution', async () => {
      vi.spyOn(renderer, 'executeAsk').mockResolvedValue(undefined);
      vi.spyOn(renderer, 'executeBatched').mockImplementation(async (_query, _sources, _bindings, _buffer, executor) => {
        executor(dataFactory.namedNode('urn:batch'));
        return 'result';
      });
      expect(renderer.executeAsk).not.toHaveBeenCalled();
      expect(renderer.executeBatched).not.toHaveBeenCalled();
      await expect(renderer.askBatched('query', [], [])).resolves.toBe('result');
      expect(renderer.executeBatched).toHaveBeenCalledOnce();
      expect(renderer.executeAsk).toHaveBeenCalledOnce();
    });
  });

  describe('selectBatched', () => {
    it('invokes batched execution', async () => {
      vi.spyOn(renderer, 'executeSelect').mockResolvedValue(undefined);
      vi.spyOn(renderer, 'executeBatched').mockImplementation(async (_query, _sources, _bindings, _buffer, executor) => {
        executor(dataFactory.namedNode('urn:batch'));
        return 'result';
      });
      expect(renderer.executeSelect).not.toHaveBeenCalled();
      expect(renderer.executeBatched).not.toHaveBeenCalled();
      await expect(renderer.selectBatched('query', [], [])).resolves.toBe('result');
      expect(renderer.executeBatched).toHaveBeenCalledOnce();
      expect(renderer.executeSelect).toHaveBeenCalledOnce();
    });
  });

  describe('selectAll', () => {
    it('executes a select query and converts output to array', async () => {
      vi.spyOn(queryEngine, 'queryBindings').mockResolvedValue(new ArrayIterator([
        'bindings1',
        'bindings2'
      ]) as unknown as BindingsStream);
      expect(queryEngine.queryBindings).not.toHaveBeenCalled();
      await expect(renderer.selectAll('query', [])).resolves.toEqual([
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
        const queryIdentifier = renderer.generateQueryIdentifier(query, sources, bindings).value;
        expectedResults[queryIdentifier] = Math.random() < 0.5 ? true : false;
        actualResults[queryIdentifier] = renderer.executeBatched(query, sources, bindings, buffer, executor);
      }
      vi.runAllTimers();
      for (const [queryIdentifier, expectedResult] of Object.entries(expectedResults)) {
        await expect(actualResults[queryIdentifier]).resolves.toBe(expectedResult);
      }
      expect(buffer).toEqual({});
    });
  });

  describe('executeAsk', () => {
    let resolveMock: (result: boolean) => void;
    let rejectMock: (error: unknown) => void;

    const batchIdentifier = dataFactory.namedNode('urn:batch');
    const queryIdentifier = dataFactory.namedNode('urn:query');
    const emptyQueryIdentifier = dataFactory.namedNode('urn:empty');

    beforeEach(() => {
      resolveMock = vi.fn();
      rejectMock = vi.fn();
    });

    it('executes a batch of ask queries', async () => {
      vi.spyOn(renderer, 'selectAll').mockResolvedValue([
        new Map<string, RDF.NamedNode>([
          ['query', queryIdentifier],
          ['s', dataFactory.namedNode('ex:s')]
        ]) as unknown as RDF.Bindings
      ]);
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: 'ASK WHERE { ?s ?p ?o }',
          rejections: { [queryIdentifier.value]: [rejectMock], [emptyQueryIdentifier.value]: [rejectMock] },
          resolutions: { [queryIdentifier.value]: [resolveMock], [emptyQueryIdentifier.value]: [resolveMock] },
          sources: []
        }
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(rejectMock).not.toHaveBeenCalled();
      expect(resolveMock).toHaveBeenCalledTimes(2);
      expect(resolveMock).toHaveBeenNthCalledWith(1, true);
      expect(resolveMock).toHaveBeenNthCalledWith(2, false);
    });

    it('forwards errors to all original reject functions', async () => {
      vi.spyOn(renderer, 'selectAll').mockRejectedValue(new Error('Query error'));
      const buffer: QueryBuffer<boolean> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: 'ASK WHERE { ?s ?p ?o }',
          rejections: { [queryIdentifier.value]: [rejectMock] },
          resolutions: { [queryIdentifier.value]: [resolveMock] },
          sources: []
        }
      };
      await expect(renderer.executeAsk(buffer, batchIdentifier)).rejects.toThrow('Query error');
      expect(rejectMock).toHaveBeenCalledOnce();
      expect(resolveMock).not.toHaveBeenCalled();
    });
  });

  describe('executeSelect', () => {
    let rejectMock: (error: unknown) => void;
    let resolveMock: (result: RDF.Bindings[]) => void;

    const batchIdentifier = dataFactory.namedNode('urn:batch');
    const queryIdentifier = dataFactory.namedNode('urn:query');
    const emptyQueryIdentifier = dataFactory.namedNode('urn:empty');

    beforeEach(() => {
      rejectMock = vi.fn();
      resolveMock = vi.fn();
    });

    it('executes a batch of select queries', async () => {
      vi.spyOn(renderer, 'selectAll').mockResolvedValue([
        new Map<string, RDF.NamedNode>([
          ['query', queryIdentifier],
          ['s', dataFactory.namedNode('ex:s1')]
        ]) as unknown as RDF.Bindings,
        new Map<string, RDF.NamedNode>([
          ['query', queryIdentifier],
          ['s', dataFactory.namedNode('ex:s2')]
        ]) as unknown as RDF.Bindings
      ]);
      const buffer: QueryBuffer<RDF.Bindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: 'SELECT ?s WHERE { ?s ?p ?o }',
          rejections: { [queryIdentifier.value]: [rejectMock], [emptyQueryIdentifier.value]: [rejectMock] },
          resolutions: { [queryIdentifier.value]: [resolveMock], [emptyQueryIdentifier.value]: [resolveMock] },
          sources: []
        }
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).resolves.not.toThrow();
      expect(rejectMock).not.toHaveBeenCalled();
      // Both the empty and the non-empty query should have been resolved
      expect(resolveMock).toHaveBeenCalledTimes(2);
      // Ensure the empty query was resolved without bindings
      expect(resolveMock).toHaveBeenNthCalledWith(2, []);
    });

    it('forwards errors to all original reject functions', async () => {
      vi.spyOn(renderer, 'selectAll').mockRejectedValue(new Error('Query error'));
      const buffer: QueryBuffer<RDF.Bindings[]> = {
        [batchIdentifier.value]: {
          bindings: [],
          query: 'SELECT ?s WHERE { ?s ?p ?o }',
          rejections: { [queryIdentifier.value]: [rejectMock], [emptyQueryIdentifier.value]: [rejectMock] },
          resolutions: { [queryIdentifier.value]: [resolveMock], [emptyQueryIdentifier.value]: [resolveMock] },
          sources: []
        }
      };
      await expect(renderer.executeSelect(buffer, batchIdentifier)).rejects.toThrow('Query error');
      expect(resolveMock).not.toHaveBeenCalled();
      expect(rejectMock).toHaveBeenCalledTimes(2);
    });
  });
});
