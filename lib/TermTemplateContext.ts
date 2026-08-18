import type * as RDF from '@rdfjs/types';

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
   * Execute a SPARQL SELECT query against the current endpoint.
   */
  querySelect: (query: string, bindings?: Record<string, RDF.NamedNode | RDF.Literal>[]) => Promise<Record<string, RDF.Term>[]>;
  /**
   * Execute a SPARQL ASK query against the current endpoint.
   */
  queryAsk: (query: string, bindings?: Record<string, RDF.NamedNode | RDF.Literal>[]) => Promise<boolean>;
}

export type { ITermTemplateContext };
