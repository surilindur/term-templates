import type * as RDF from '@rdfjs/types';

/**
 * Representation of an RDF term template in TypeScript,
 * to be instantiated using a set of bindings containing the template data.
 */
class TermTemplate {
  public readonly id: string;
  public readonly pattern: RegExp;
  public readonly text: string;
  public readonly target: string;

  public constructor(bindings: RDF.Bindings) {
    this.id = (bindings.get('template') as RDF.Literal).value;
    this.pattern = new RegExp((bindings.get('pattern') as RDF.Literal).value, 'u');
    this.text = (bindings.get('text') as RDF.Literal).value;
    this.target = (bindings.get('target') as RDF.NamedNode).value;
  }

  /**
   * Calculate the relevance score for this template against the specified RDF term.
   * The relevance is based on regex match length, with longer match being more relevant.
   * @param term The RDF term to calculate relevance for.
   * @returns The relevance as a numeric value, where higher is more relevant.
   */
  public calculateRelevance(term: RDF.Term): number {
    const match = this.pattern.exec(term.value);
    return match?.[0].length ?? Number.NEGATIVE_INFINITY;
  }
}

export { TermTemplate };
