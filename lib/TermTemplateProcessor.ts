import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import type { BindingsStream, IQueryEngine, QuerySourceUnidentified } from '@comunica/types';
import { AlgebraFactory, algebraUtils } from '@comunica/utils-algebra';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import { Eta } from 'eta';
import { TermTemplate } from './TermTemplate';
import type { ITermTemplateContext } from './TermTemplateContext';

class TermTemplateProcessor {
  public readonly queryEngine: IQueryEngine;
  public readonly templateSources: QuerySourceUnidentified[];

  public readonly templates: Map<string, TermTemplate>;

  public static readonly eta = new Eta({ useWith: true });
  public static readonly sparqlParser = new Parser();
  public static readonly sparqlGenerator = new Generator();
  public static readonly dataFactory = new DataFactory();
  public static readonly algebraFactory = new AlgebraFactory(TermTemplateProcessor.dataFactory);

  public constructor(options: ITermTemplateProcessorOptions) {
    this.queryEngine = options.queryEngine;
    this.templateSources = options.templateSources;
    this.templates = new Map();
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
        queryAsk: async (query, bindings) => {
          const queryWithBindings = TermTemplateProcessor.addBindingsToQuery(query, bindings ?? []);
          const result = await this.queryEngine.queryBoolean(queryWithBindings, { sources: [template.target] });
          return result;
        },
        querySelect: async (query, bindings) => {
          const queryWithBindings = TermTemplateProcessor.addBindingsToQuery(query, bindings ?? []);
          const result = await this.queryEngine.queryBindings(queryWithBindings, { sources: [template.target] });
          const output = await TermTemplateProcessor.bindingsToRecords(result);
          return output;
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

  public static async bindingsToRecords(bindingsStream: BindingsStream): Promise<Record<string, RDF.Term>[]> {
    const output: Record<string, RDF.Term>[] = [];
    for await (const bindings of bindingsStream) {
      const record: Record<string, RDF.Term> = {};
      for (const [key, value] of bindings) {
        record[key.value] = value;
      }
      output.push(record);
    }
    return output;
  }

  public static addBindingsToQuery(query: string, bindings: Record<string, RDF.NamedNode | RDF.Literal>[]): string {
    const parsedQuery = TermTemplateProcessor.sparqlParser.parse(query);
    const parsedAlgebra = toAlgebra(parsedQuery);

    const operationWithValues = algebraUtils.mapOperation(parsedAlgebra, {
      project: {
        preVisitor: () => ({ shortcut: true, copy: false }),
        transform: (_copy, op) => TermTemplateProcessor.algebraFactory.createProject(
          TermTemplateProcessor.algebraFactory.createJoin([
            op.input,
            TermTemplateProcessor.algebraFactory.createValues(
              [...new Set(bindings.flatMap(b => Object.keys(b)))].map(s => TermTemplateProcessor.dataFactory.variable(s)),
              bindings
            )
          ]),
          op.variables
        )
      }
    }) as Algebra.Operation;

    const operationWithValuesAst = toAst(operationWithValues);
    const operationWithValuesQueryString = TermTemplateProcessor.sparqlGenerator.generate(operationWithValuesAst);

    return operationWithValuesQueryString;
  }
}

interface ITermTemplateProcessorOptions {
  queryEngine: IQueryEngine;
  templateSources: QuerySourceUnidentified[];
}

export { TermTemplateProcessor, type ITermTemplateProcessorOptions };
