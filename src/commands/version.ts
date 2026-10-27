import { packageVersion } from '../core/version.ts';
import type { CommandFn } from './types.ts';

const version: CommandFn = async () => {
  const v = packageVersion();
  return { ok: true, text: `screenrec ${v}`, version: v };
};
export default version;
