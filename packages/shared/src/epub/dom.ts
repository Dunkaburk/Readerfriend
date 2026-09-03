/**
 * DOM helpers over linkedom. linkedom is pure JS and works in Web Workers,
 * which is why it is used here instead of DOMParser (unavailable in workers).
 */

import { DOMParser, parseHTML } from 'linkedom';
import { ELEMENT_NODE, type MiniElement, type MiniNode } from '../text';

/**
 * Parse an HTML fragment/document for tree walking. linkedom puts fragment
 * content directly on the returned Document (full documents get html/body),
 * so callers always walk the returned node, never `.body`.
 */
export function parseFragment(html: string): MiniNode {
  return parseHTML(html).document as unknown as MiniNode;
}

/** Parse an XML document (container.xml, OPF, NCX). Throws on garbage. */
export function parseXmlDoc(xml: string): MiniNode {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as MiniNode;
}

/** Local name of a nodeName: prefix stripped, lowercased. */
export function localNameOfName(nodeName: string): string {
  const idx = nodeName.indexOf(':');
  return idx === -1 ? nodeName.toLowerCase() : nodeName.slice(idx + 1).toLowerCase();
}

export function elementLocalName(el: MiniElement): string {
  return localNameOfName(el.nodeName);
}

/** Iterate all descendant elements in document order. */
export function* iterateElements(root: MiniNode): Generator<MiniElement> {
  if (root.nodeType === ELEMENT_NODE) {
    yield root as MiniElement;
  }
  const children = root.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child) yield* iterateElements(child);
  }
}

/** First element whose local name matches (case-insensitive), in document order. */
export function firstByLocalName(root: MiniNode, local: string): MiniElement | null {
  const target = local.toLowerCase();
  for (const el of iterateElements(root)) {
    if (elementLocalName(el) === target) return el;
  }
  return null;
}

/** All elements whose local name matches (case-insensitive), in document order. */
export function allByLocalName(root: MiniNode, local: string): MiniElement[] {
  const target = local.toLowerCase();
  const out: MiniElement[] = [];
  for (const el of iterateElements(root)) {
    if (elementLocalName(el) === target) out.push(el);
  }
  return out;
}

/** First element whose *tag name* (uppercased) matches exactly. */
export function firstByTagName(root: MiniNode, tagName: string): MiniElement | null {
  const target = tagName.toUpperCase();
  for (const el of iterateElements(root)) {
    if (el.nodeName.toUpperCase() === target) return el;
  }
  return null;
}

export function attr(el: MiniElement, name: string): string | null {
  return el.getAttribute?.(name) ?? null;
}
