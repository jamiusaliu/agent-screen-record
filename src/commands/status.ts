import { recordingStatus } from '../recorder.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async () => ({ ok: true, ...(await recordingStatus()) });
export default cmd;
