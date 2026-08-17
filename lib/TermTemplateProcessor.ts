import type * as RDF from '@rdfjs/types';
import MurmurHash3 from 'imurmurhash';
import { DataFactory } from 'rdf-data-factory';
import type { IQueryEngine, QuerySourceUnidentified } from '@comunica/types';
import type { Algebra, AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import { Eta } from 'eta';
import { TermTemplate } from './TermTemplate';
import type { ITermTemplateContext } from './TermTemplateContext';

type QueryBatch<T> = {
  query: string;
  sources: string[];
  bindings: Record<string, RDF.NamedNode | RDF.Literal>[];
  resolutions: Record<string, ((value: T) => void)[]>;
  rejections: Record<string, ((error: unknown) => void)[]>;
};

type QueryBuffer<T> = Record<string, QueryBatch<T>>;

class TermTemplateProcessor {
  public readonly queryEngine: IQueryEngine;
  public readonly dataFactory: DataFactory;
  public readonly algebraFactory: AlgebraFactory;

  public readonly templateSources: QuerySourceUnidentified[];
  public readonly templates: Map<string, TermTemplate>;
  public readonly selectBuffer: QueryBuffer<RDF.Bindings[]>;
  public readonly askBuffer: QueryBuffer<boolean>;
  public readonly batchWindowMilliseconds: number;
  public readonly queryIdentifierVariable: RDF.Variable;

  public static readonly eta = new Eta({ useWith: true });
  public static readonly sparqlParser = new Parser();
  public static readonly sparqlGenerator = new Generator();

  public constructor(options: ITermTemplateProcessorOptions) {
    this.queryEngine = options.queryEngine;
    this.dataFactory = options.dataFactory;
    this.algebraFactory = options.algebraFactory;
    this.templateSources = options.templateSources;
    this.templates = new Map();
    this.selectBuffer = {};
    this.askBuffer = {};
    this.batchWindowMilliseconds = options.batchWindow;
    this.queryIdentifierVariable = options.dataFactory.variable(options.queryIdentifierVariable);
  }

  /**
   * Triggers a template collection from all the configured sources.
   */
  public async loadTemplates(): Promise<void> {
    this.templates.clear();
    const templateQuery = `PREFIX schema: <https://schema.org/>

SELECT DISTINCT ?template ?priority ?text ?pattern ?target WHERE {
    ?template a schema:SoftwareSourceCode .
    ?template schema:codeSampleType ?type .
    ?template schema:text ?text .
    ?template schema:pattern ?pattern .
    ?template schema:target ?target .

    OPTIONAL { ?template schema:order ?order . }

    BIND(COALESCE(?order, 0) AS ?priority)
} ORDER BY ?priority`;
    const bindingsStream = await this.queryEngine.queryBindings(templateQuery, { sources: this.templateSources });
    for await (const bindings of bindingsStream) {
      const identifier = (bindings.get('template') as RDF.NamedNode | RDF.BlankNode).value;
      if (!this.templates.has(identifier)) {
        this.templates.set(identifier, new TermTemplate(bindings));
      }
    }
  }

  public static parseOperation(op: string): Algebra.Operation {
    const parsedOperation = TermTemplateProcessor.sparqlParser.parse(op);
    const parsedAlgebra = toAlgebra(parsedOperation);
    return parsedAlgebra;
  }

  public static serializeOperation(operation: Algebra.Operation): string {
    const operationAst = toAst(operation);
    const operationString = TermTemplateProcessor.sparqlGenerator.generate(operationAst);
    return operationString;
  }

  public findApplicableTemplates(term: RDF.Term): TermTemplate[] {
    const templatesWithRelevance: { template: TermTemplate; relevance: number }[] = [];
    for (const template of this.templates.values()) {
      const relevance = template.calculateRelevance(term);
      if (relevance >= 0) {
        templatesWithRelevance.push({ template, relevance });
      }
    }
    return templatesWithRelevance.sort((a, b) => b.relevance - a.relevance).map(t => t.template);
  }

  public async visualiseTerm(term: RDF.Term): Promise<string> {
    const template = this.findApplicableTemplates(term).at(0);
    if (template) {
      const templateContext: ITermTemplateContext = {
        term,
        queryAsk: (query, bindings) => this.askBatched(query, [template.target], bindings ?? []),
        querySelect: async (query, bindings) => {
          const outputBindings = await this.selectBatched(query, [template.target], bindings ?? []);
          const outputRecords = TermTemplateProcessor.bindingsToRecords(outputBindings);
          return outputRecords;
        },
        visualiseTerm: term => this.visualiseTerm(term)
      };
      try {
        return await TermTemplateProcessor.eta.renderStringAsync(template.text, templateContext);
      } catch (error: unknown) {
        return `<pre class="error">${error}</pre>`;
      }
    }
    return `<pre>${JSON.stringify(term, undefined, 2)}</pre>`;
  }

  public static bindingsToRecords(bindings: RDF.Bindings[]): Record<string, RDF.Term>[] {
    const output: Record<string, RDF.Term>[] = [];
    for (const mapping of bindings) {
      const record: Record<string, RDF.Term> = {};
      for (const [key, value] of mapping) {
        record[key.value] = value;
      }
      output.push(record);
    }
    return output;
  }

  public bindingsToValues(bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Algebra.Values {
    return this.algebraFactory.createValues(
      [...new Set(bindings.flatMap(b => Object.keys(b)))].map(s => this.dataFactory.variable(s)),
      bindings
    );
  }

  public addBindings(query: string, bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): string {
    const operation = TermTemplateProcessor.parseOperation(query);

    const operationWithValues = algebraUtils.mapOperation(operation, {
      project: {
        preVisitor: () => ({ shortcut: true, copy: false }),
        transform: (_copy, op) => this.algebraFactory.createProject(
          this.algebraFactory.createJoin([op.input, this.bindingsToValues(bindings)]),
          op.variables
        )
      }
    }) as Algebra.Operation;

    return TermTemplateProcessor.serializeOperation(operationWithValues);
  }

  /**
   * Generate a query identifier that takes into account also the binding values.
   */
  public generateQueryIdentifier(query: string, sources: string[], bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      sources: sources.sort(),
      // Ensure the binding objects always sorted identically
      bindings: Object.fromEntries(Object.entries(bindings).sort((a, b) => a[0] < b[0] ? -1 : 1))
    });
    const hash = MurmurHash3(value).result().toString(16);
    return this.dataFactory.namedNode(`urn:query:${hash}`);
  }

  /**
   * Generate a query batch identifier, to allow grouping together identical queries to a single source.
   */
  public generateQueryBatchIdentifier(query: string, sources: string[], bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): RDF.NamedNode {
    const value = JSON.stringify({
      query,
      sources: sources.sort(),
      // Only considers the keys, because different values could exist for the variables
      bindings: Object.keys(bindings).sort()
    });
    const hash = MurmurHash3(value).result().toString(16);
    return this.dataFactory.namedNode(`urn:batch:${hash}`);
  }

  /**
   * Helper function to push executions into buffers based on identifiers.
   */
  public async executeBatched<T>(
    query: string,
    sources: string[],
    bindings: Record<string, RDF.NamedNode | RDF.Literal>[],
    buffer: QueryBuffer<T>,
    executor: (batchIdentifier: RDF.NamedNode) => Promise<void>
  ): Promise<T> {
    const queryIdentifier = this.generateQueryIdentifier(query, sources, bindings);
    const batchIdentifier = this.generateQueryBatchIdentifier(query, sources, bindings);

    // Add the current query identifier to the bindings
    bindings = bindings.map(b => ({ ...b, [this.queryIdentifierVariable.value]: queryIdentifier }));

    return new Promise<T>((resolve, reject) => {
      if (buffer[batchIdentifier.value]) {
        if (
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value]
          && buffer[batchIdentifier.value].rejections[queryIdentifier.value]
        ) {
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value].push(resolve);
          buffer[batchIdentifier.value].rejections[queryIdentifier.value].push(reject);
        } else {
          buffer[batchIdentifier.value].bindings.push(...bindings);
          buffer[batchIdentifier.value].resolutions[queryIdentifier.value] = [resolve];
          buffer[batchIdentifier.value].rejections[queryIdentifier.value] = [reject];
        }
      } else {
        const selectOperation = TermTemplateProcessor.parseOperation(query);
        const selectOperationWithQueryVariable = algebraUtils.mapOperation(selectOperation, {
          project: {
            preVisitor: () => ({ shortcut: true, copy: false }),
            transform: (_copy, op) => this.algebraFactory.createProject(op.input, [...op.variables, this.queryIdentifierVariable])
          }
        }) as Algebra.Operation;

        buffer[batchIdentifier.value] = {
          query: TermTemplateProcessor.serializeOperation(selectOperationWithQueryVariable),
          sources,
          bindings,
          resolutions: { [queryIdentifier.value]: [resolve] },
          rejections: { [queryIdentifier.value]: [reject] }
        };
        setTimeout(() => executor(batchIdentifier), this.batchWindowMilliseconds);
      }
    });
  }

  public async executeAsk(batchIdentifier: RDF.NamedNode): Promise<void> {
    const batch = this.askBuffer[batchIdentifier.value];
    delete this.askBuffer[batchIdentifier.value];
    console.log('ASK', batch);

    const askOperation = TermTemplateProcessor.parseOperation(batch.query);

    const selectOperation = algebraUtils.mapOperation(askOperation, {
      ask: {
        preVisitor: () => ({ shortcut: true, copy: false }),
        transform: (_, op) => this.algebraFactory.createProject(
          this.algebraFactory.createFilter(
            this.bindingsToValues(batch.bindings),
            this.algebraFactory.createExistenceExpression(false, op.input)
          ),
          [this.queryIdentifierVariable]
        )
      }
    }) as Algebra.Operation;

    try {
      const queryString = TermTemplateProcessor.serializeOperation(selectOperation);
      const bindingsArray = await this.selectAll(queryString, batch.sources);

      // Report existence to their corresponding queries
      for (const bindings of bindingsArray) {
        const queryIdentifier = (bindings.get(this.queryIdentifierVariable) as RDF.NamedNode).value;
        for (const resolution of batch.resolutions[queryIdentifier]) {
          resolution(true);
        }
        delete batch.resolutions[queryIdentifier];
      }

      // Report non-existence to all other queries
      for (const resolutions of Object.values(batch.resolutions)) {
        for (const resolution of resolutions) {
          resolution(false);
        }
      }
    } catch (error: unknown) {
      // Send the error to all queries
      for (const rejections of Object.values(batch.rejections)) {
        for (const rejection of rejections) {
          rejection(error);
        }
      }
      // Raise the error so it gets propagated
      throw error;
    }
  }

  public async selectAll(query: string, sources: string[]): Promise<RDF.Bindings[]> {
    const bindingsStream = await this.queryEngine.queryBindings(query, { sources, lenient: true });
    const bindingsArray = await bindingsStream.toArray();
    return bindingsArray;
  }

  public async executeSelect(batchIdentifier: RDF.NamedNode): Promise<void> {
    const batch = this.selectBuffer[batchIdentifier.value];
    delete this.selectBuffer[batchIdentifier.value];
    console.log('SELECT', batch);

    try {
      const queryWithBindings = this.addBindings(batch.query, batch.bindings);
      const bindingsArray = await this.selectAll(queryWithBindings, batch.sources);
      const bindingsByQuery: Record<string, RDF.Bindings[]> = {};

      for (const bindings of bindingsArray) {
        console.log('bindings', bindings);
        const queryIdentifier = (bindings.get(this.queryIdentifierVariable) as RDF.NamedNode).value;
        if (bindingsByQuery[queryIdentifier]) {
          bindingsByQuery[queryIdentifier].push(bindings);
        } else {
          bindingsByQuery[queryIdentifier] = [bindings];
        }
      }

      // Forward bindings to their respective resolution functions
      for (const [identifier, bindings] of Object.entries(bindingsByQuery)) {
        for (const resolution of batch.resolutions[identifier]) {
          resolution(bindings);
        }
        delete batch.resolutions[identifier];
      }

      // Mark all remaining queries without bindings as finished
      for (const resolutions of Object.values(batch.resolutions)) {
        for (const resolution of resolutions) {
          resolution([]);
        }
      }
    } catch (error: unknown) {
      // Send the error to all queries
      for (const rejections of Object.values(batch.rejections)) {
        for (const rejection of rejections) {
          rejection(error);
        }
      }
      // Raise the error so it gets propagated
      throw error;
    }
  }

  public async askBatched(query: string, sources: string[], bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Promise<boolean> {
    return this.executeBatched<boolean>(query, sources, bindings, this.askBuffer, batch => this.executeAsk(batch));
  }

  public async selectBatched(query: string, sources: string[], bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): Promise<RDF.Bindings[]> {
    return this.executeBatched<RDF.Bindings[]>(query, sources, bindings, this.selectBuffer, batch => this.executeSelect(batch));
  }
}

interface ITermTemplateProcessorOptions {
  /**
   * The query engine to use for template retrieval and within the templates themselves.
   */
  queryEngine: IQueryEngine;
  /**
   * The data factory to use for creating RDF terms.
   */
  dataFactory: DataFactory;
  /**
   * The algebra factory to use for creating algebra objects.
   */
  algebraFactory: AlgebraFactory;
  /**
   * The sources to retrieve templates from.
   */
  templateSources: QuerySourceUnidentified[];
  /**
   * The window in milliseconds for every query batch.
   */
  batchWindow: number;
  /**
   * The variable name to use for mapping solutions back to the original query in batches.
   * This is added to each query that is sent to the server, so ensure it does not conflict
   * with existing variables in queries, including the queries within templates.
   */
  queryIdentifierVariable: string;
}

export { TermTemplateProcessor, type ITermTemplateProcessorOptions };
