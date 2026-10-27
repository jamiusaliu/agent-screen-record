import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson, ScreenrecError } from '../core/errors.ts';
import type { ParsedArgs, CommandFn, CommandResult } from '../commands/types.ts';
import { runFfmpeg } from '../edit/ffmpeg.ts';
import { packageVersion } from '../core/version.ts';
import doctor from '../commands/doctor.ts';
import list from '../commands/list.ts';
import start from '../commands/start.ts';
import status from '../commands/status.ts';
import mark from '../commands/mark.ts';
import stop from '../commands/stop.ts';
import screenshot from '../commands/screenshot.ts';
import squeeze from '../commands/squeeze.ts';
import crop from '../commands/crop.ts';
import blur from '../commands/blur.ts';
import trim from '../commands/trim.ts';
import gif from '../commands/gif.ts';
import frameCmd from '../commands/frame.ts';

export const TOOL_NAMES = ['doctor', 'list_targets', 'record_start', 'record_status', 'record_mark', 'record_stop', 'screenshot',
  'video_squeeze', 'video_crop', 'video_blur', 'video_trim', 'video_gif', 'video_frame'] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const PREVIEW_WIDTH = 480;
const DISPLAY_WARNING = 'Captures notifications and all other windows on that display; suggest the user turns on a Focus mode first.';
const PATH = 'Absolute path or ~/.';
const DEFAULT_DIR = 'The folder is ./recordings, or ~/Movies/screenrec when the server runs in / or an unwritable folder.';

const target = {
  window: z.string().optional().describe('"App", "App:title part" (split on the first colon) or a window id. Preferred target.'),
  app: z.string().optional().describe("App name: records that app's front window."),
  display: z.string().optional().describe(`main, a 1-based number or part of a display name. ${DISPLAY_WARNING}`),
  display_of: z.string().optional().describe(`Record the whole display that holds this window ("App" or "App:title part"). ${DISPLAY_WARNING}`),
  region: z.string().optional().describe(`x,y,w,h in points from the top-left of the display given in display (default main). ${DISPLAY_WARNING}`),
  tab: z.string().optional().describe('Chrome tab, recorded even when hidden: newest (the newest tab created after start), ' +
    'follow (starts on newest, then switches to whichever tab is created or activated next; only tabs created after start, including ones the user opens by hand), ' +
    'url:<text> or title:<text> (an existing tab).'),
  cdp: z.string().optional().describe('Loopback CDP endpoint of a test browser, e.g. http://127.0.0.1:9222. Only with tab (or list_targets kind tabs); refused with any other target. Omit to use your running Chrome.'),
};

type Values = Record<string, unknown>;
type Shape = Record<string, z.ZodTypeAny>;
type Image = { type: 'image'; data: string; mimeType: string };
const kebab = (k: string) => k.replace(/_/g, '-');

/** Expands a leading "~" or "~/" with the home directory. "~user" and inner tildes are left alone. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
const PATH_KEYS = ['input', 'out', 'boxes'];

/** MCP inputs are snake_case and typed; commands take the CLI's kebab-case flags as strings. */
export function toArgs(command: string, positionals: string[], values: Values): ParsedArgs {
  const v: ParsedArgs['values'] = {};
  for (const [k, val] of Object.entries(values)) {
    if (val === undefined) continue;
    v[kebab(k)] = typeof val === 'number' ? String(val) : (val as string | boolean | string[]);
  }
  return { command, positionals, values: v, json: true };
}

/**
 * The SDK rejects schema violations with its own plain-text error. To keep every failure in the
 * errorJson shape, the advertised schema has the precise JSON Schema of each field but accepts any
 * value; the handler then validates with the precise zod shape and throws E_BAD_ARGS.
 */
function looseSchema(shape: Shape) {
  const loose: Shape = {}; const required: string[] = [];
  for (const [k, s] of Object.entries(shape)) {
    const { $schema: _, ...json } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    loose[k] = z.unknown().optional().meta(json);
    if (!s.safeParse(undefined).success) required.push(k);
  }
  return z.object(loose).meta({ required });
}

function validate(name: string, shape: Shape, a: Values): Values {
  const r = z.object(shape).safeParse(a ?? {});
  if (r.success) return r.data as Values;
  const issues = r.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
  throw new ScreenrecError('E_BAD_ARGS', `Invalid input for ${name}: ${issues.join('; ')}`,
    `Fix the named field and call ${name} again; its input schema lists each field's type and which ones are required.`);
}

/** One PNG at most PREVIEW_WIDTH px wide (never upscaled) of `file` (video or image). Written to a temp dir, never next to the user's files. */
async function preview(file: string, at = 0): Promise<Image> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-preview-'));
  try {
    const out = path.join(dir, 'preview.png');
    await runFfmpeg(['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `scale='min(${PREVIEW_WIDTH},iw)':-2`, out]);
    return { type: 'image', data: fs.readFileSync(out).toString('base64'), mimeType: 'image/png' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Inputs that become positionals, not flags.
const POSITIONAL_KEYS = ['input', 'text', 'kind'];

function tool(
  server: McpServer, name: ToolName, description: string, shape: Shape,
  run: CommandFn, command: string, positional: (a: Values) => string[],
  withImage?: (r: CommandResult) => Promise<Image>,
) {
  server.registerTool(name, { description, inputSchema: looseSchema(shape) }, async (raw: Values) => {
    try {
      const a = validate(name, shape, raw);
      for (const k of PATH_KEYS) if (typeof a[k] === 'string') a[k] = expandHome(a[k] as string);
      const rest = { ...a }; for (const k of POSITIONAL_KEYS) delete rest[k];
      const r = await run(toArgs(command, positional(a), rest));
      let img: Image | null = null;
      // A failed preview must not hide a successful command: report it next to the result.
      if (withImage) {
        try { img = await withImage(r); }
        catch (e) { r.previewError = e instanceof Error ? e.message : String(e); }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }, ...(img ? [img] : [])] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorJson(e)) }] };
    }
  });
}

export function buildServer(): McpServer {
  const s = new McpServer({ name: 'screenrec', version: packageVersion() });
  const none = () => [];
  const input = (a: Values) => [String(a.input)];
  const inFile = z.string().describe(`Input video (mp4 or mov; AV1 or variable frame rate is fine). ${PATH}`);
  const out = z.string().optional().describe(`Output path. ${PATH} Default <input>.<command>.<ext> next to the input (in the default recordings folder if the input's folder is not writable); the input is never overwritten. An existing file is refused unless force is true.`);
  const force = z.boolean().optional().describe('Replace the file at out (and its .json sidecar) if it already exists. Default false: an existing out is refused. Never replaces the input.');
  const forceRec = z.boolean().optional().describe('Replace the file at out (and its .json sidecar) if it already exists; the old file stays until record_stop saves a playable recording. Default false: an existing out is refused.');
  const forceShot = z.boolean().optional().describe('Replace the file at out if it already exists. Default false: an existing out is refused.');

  tool(s, 'doctor', 'Check that recording will work here: Screen Recording permission, ffmpeg, capture helper, Chrome version and remote debugging, Chrome DevTools MCP route. Returns each check with the exact fix to relay to the user. A check with warn: true is optional or advice (for example remote debugging off): it never makes allPassed false, so relay it as a suggestion, not a failure.', {}, doctor, 'doctor', none);
  tool(s, 'list_targets', 'List what can be recorded: windows (with ids), displays, or Chrome tabs (title and url).',
    { kind: z.enum(['windows', 'displays', 'tabs']), cdp: target.cdp }, list, 'list', (a) => [String(a.kind)]);
  tool(s, 'record_start',
    'Start recording one target, locally (nothing is uploaded). Before calling, tell the user in chat that you are starting a recording and what it will capture. ' +
    'Prefer a window or tab target over a display. Use follow_app when the work will open other apps (Finder opening Preview). ' +
    'Then do the task, call record_mark at each step, and call record_stop. Auto-stops after max (default 10m). ' +
    'If the result has "recovered", an earlier crashed recording was saved; mention its path. ' +
    'A tab start can wait up to about 2.5 minutes for the user to click Allow in Chrome; if the call times out, call record_status before starting again. Make one record_* call at a time.',
    { ...target,
      follow_app: z.boolean().optional().describe('Follow the work into new windows of other apps it opens. Needs window or app (refused with any other target).'),
      ignore_app: z.array(z.string()).optional().describe('Apps that follow_app must never switch to (default: the terminal or IDE that started it). Needs follow_app.'),
      out: z.string().optional().describe(`Output .mp4 (another extension is refused). ${PATH} Default <folder>/<timestamp>.mp4. ${DEFAULT_DIR} An existing file is refused unless force is true.`),
      force: forceRec,
      fps: z.number().optional().describe('Frames per second: a whole number from 1 to 120, default 30.'),
      cursor: z.boolean().optional().describe('Show the mouse pointer (hidden by default).'),
      max: z.string().optional().describe('Auto-stop after e.g. 90s, 10m (default), 1h; from 1s to 24h.'),
      no_meta: z.boolean().optional().describe('Skip the JSON sidecar (it holds window titles, URLs and step notes, which can be sensitive).') },
    start, 'start', none);
  tool(s, 'record_status', 'Is a recording running? Shows target, elapsed time and output path; for a window or app recording, targetState is "hidden" while the window is minimized, hidden or closed (the last frame is held) and "visible" otherwise. Also finalises a crashed recording and reports it as recovered.', {}, status, 'status', none);
  tool(s, 'record_mark', 'Add a timestamped step note to the running recording, e.g. "clicked Download". Call after each meaningful step. Keep secrets out of notes: they are saved in the sidecar.',
    { text: z.string().describe('Short note of what you just did.') }, mark, 'mark', (a) => [String(a.text)]);
  tool(s, 'record_stop',
    'Stop and save the recording as mp4 (plus a JSON sidecar with step notes). After it returns, tell the user in chat that you stopped recording and give the saved file path. ' +
    'Returns a preview frame so you can check it recorded the right thing; if not, say so and offer to redo it. "recovered": true means the recorder had crashed and the partial file was saved.',
    {}, stop, 'stop', none,
    async (r) => preview(String(r.out), Math.max(0, Number(r.durationSec) / 2 || 0)));
  tool(s, 'screenshot', 'Save one PNG and return it. Prefer a window or tab target (tab needs url:<text> or title:<text>); a display or region also shows notifications and other windows.',
    { ...target, out: z.string().optional().describe(`Output png, ${PATH} Default <folder>/<timestamp>.png. ${DEFAULT_DIR} An existing file is refused unless force is true.`), force: forceShot }, screenshot, 'screenshot', none,
    async (r) => preview(String(r.out)));
  tool(s, 'video_squeeze', 'Remove frozen stretches (waiting for a page or an answer, idle pauses): each still screen is kept for at most hold seconds so it stays readable; 0 gives the fastest cut. Re-times step notes in the sidecar. Run it first.',
    { input: inFile, out, force, fps: z.number().optional(),
      hold: z.number().min(0).optional().describe('Seconds each still screen is kept, default 0.5; 0 cuts it to one frame.') }, squeeze, 'squeeze', input);
  tool(s, 'video_crop', 'Crop by rect "x,y,w,h" in output pixels, or trim_edges N pixels from every side (8 removes Claude in Chrome\'s edge glow).',
    { input: inFile, rect: z.string().optional(), trim_edges: z.number().optional(), out, force }, crop, 'crop', input);
  tool(s, 'video_blur', 'Pixelate then blur private areas so text cannot be recovered. Boxes are in output pixels of the file being blurred, so blur after squeeze, crop and trim and measure on that file with video_frame. box: ["x,y,w,h" or "x,y,w,h@from-to"]; boxes: JSON file with keyframed boxes for scrolling content. A box without from-to covers the whole video; a keyframed box without from/to is held at its first keyframe before it and at its last after it, so nothing is left unblurred; a box whose window starts at or after the end of the video, or in its last frame interval (at least the last 0.1 s), is refused with E_BAD_ARGS.',
    { input: inFile, box: z.array(z.string()).optional(), boxes: z.string().optional().describe(`Keyframed boxes JSON file. ${PATH}`), out, force }, blur, 'blur', input);
  tool(s, 'video_trim', 'Cut the start and end: keep from..to, in seconds.',
    { input: inFile, from: z.number().optional(), to: z.number(), out, force }, trim, 'trim', input);
  tool(s, 'video_gif', 'Export a looping GIF (two-pass palette) for READMEs and chats, from the last cleaned-up (and blurred) file. width 800 and fps 12 by default.',
    { input: inFile, width: z.number().optional(), fps: z.number().optional(), out, force }, gif, 'gif', input);
  tool(s, 'video_frame', `Save and return one still frame at a time in seconds, for checking content before sharing or measuring blur boxes (the saved PNG keeps full size; the returned image is at most ${PREVIEW_WIDTH} px wide).`,
    { input: inFile, at: z.number(), width: z.number().optional(), out, force }, frameCmd, 'frame', input,
    async (r) => preview(String(r.out)));
  return s;
}
