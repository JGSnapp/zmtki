import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const generate = customAlphabet(alphabet, 10);

/** Readable, prefixed identifiers so logs and tool arguments stay debuggable. */
export const newId = (prefix: string): string => `${prefix}_${generate()}`;
