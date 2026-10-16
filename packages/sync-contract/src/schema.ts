// Validates response bodies against the component schemas of openapi.yaml, so the published
// description and the server cannot drift apart unnoticed.
//
// Strict by default: for validation only, every object schema with `properties` is closed
// (`unevaluatedProperties: false`), so a field the server sends but openapi.yaml does not document
// fails the suite (drift detection within this repository). The published document itself stays
// open – clients must ignore unknown fields and the server may add optional ones. To run the suite
// against a newer server that legitimately adds fields, set SYNCLET_CONTRACT_LENIENT=1.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

type Json = Record<string, unknown>;

function close(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(close); return; }
  if (!node || typeof node !== 'object') return;
  const obj = node as Json;
  if (obj.type === 'object' && obj.properties && obj.additionalProperties === undefined && obj.unevaluatedProperties === undefined) {
    obj.unevaluatedProperties = false;
  }
  Object.values(obj).forEach(close);
}

const doc = parse(readFileSync(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), 'utf8')) as { components: { schemas: Json } };
const schemas = structuredClone(doc.components.schemas);
/** True when SYNCLET_CONTRACT_LENIENT=1: additional response properties are allowed. */
export const lenient = process.env.SYNCLET_CONTRACT_LENIENT === '1';
if (!lenient) close(schemas);

// CommonJS packages: depending on the loader the class is the default export or its `.default`.
const cjs = <T>(m: T): T => ((m as { default?: T }).default ?? m);
const ajv = new (cjs(Ajv2020))({ strict: false, allErrors: true });
cjs(addFormats)(ajv);
ajv.addSchema({ $id: 'synclet', components: { schemas } });

/** Returns a readable list of violations ('' when `data` matches `components.schemas[name]`). */
export function schemaErrors(name: string, data: unknown): string {
  if (!(name in schemas)) throw new Error(`unknown schema ${name}`);
  const validate = ajv.getSchema(`synclet#/components/schemas/${name}`);
  if (!validate) throw new Error(`cannot compile schema ${name}`);
  if (validate(data)) return '';
  return (validate.errors ?? []).map((e: { instancePath: string; message?: string; params?: unknown }) => `${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`).join('\n');
}

/** Same as schemaErrors for `{ type: array, items: <name> }`. */
export function arrayErrors(name: string, data: unknown): string {
  if (!Array.isArray(data)) return '/ must be array';
  return data.map((d, i) => { const e = schemaErrors(name, d); return e && e.replace(/^/gm, `[${i}]`); }).filter(Boolean).join('\n');
}
