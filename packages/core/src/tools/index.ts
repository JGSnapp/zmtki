/**
 * Importing this module registers every built-in tool. Tool modules
 * self-register at import time, so adding a tool means adding a file and a
 * line here rather than editing a central switch.
 */
import './boardTools.js';
import './fileTools.js';
import './shellTools.js';
import './webTools.js';
import './roomTools.js';
import './skillTools.js';

export * from './registry.js';
export { bindExtensionHost } from './skillTools.js';

export const BUILTIN_TOOLSETS = [
  'core',
  'board',
  'files',
  'shell',
  'web',
  'rooms',
  'skills',
  'mcp'
] as const;
export type ToolsetName = (typeof BUILTIN_TOOLSETS)[number];
