import type * as RDF from '@rdfjs/types';

/**
 * The context expected to be present in each term template.
 * This includes the term itself, that is to be visualised,
 * as well as helper functions for query execution and further visualisations.
 */
interface ITermTemplateContext {
  /**
   * The current RDF term being visualised.
   */
  term: RDF.Term;
  /**
   * Generate an HTML visualisation of the specified RDF term.
   */
  visualiseTerm: (term: RDF.Term) => Promise<string>;
  /**
   * Execute a SPARQL SELECT query against the current template's target.
   */
  querySelect: (query: string, bindings?: Record<string, RDF.NamedNode | RDF.Literal>[]) => Promise<Record<string, RDF.Term>[]>;
  /**
   * Execute a SPARQL ASK query against the current template's target.
   */
  queryAsk: (query: string, bindings?: Record<string, RDF.NamedNode | RDF.Literal>[]) => Promise<boolean>;
}

export type { ITermTemplateContext };
