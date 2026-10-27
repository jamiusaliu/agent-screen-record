import { brokerStatus, stopBroker, brokerIdleMs } from '../capture/cdp/broker-client.ts';
import { redactUrl } from '../capture/cdp/endpoint.ts';
import type { BrokerInfo } from '../capture/cdp/broker.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from './types.ts';

const minutes = (ms: number) => `${Math.round(ms / 60000)} min`;

/** The doctor line for the broker (spec 6.6). Never includes the token. */
export function brokerDoctorCheck(info: BrokerInfo | null, idleMs: number = brokerIdleMs()): { name: string; ok: boolean; detail: string } {
  if (!info) return { name: 'Chrome broker', ok: true, detail: `not running (starts on the first tab recording; idle timeout ${minutes(idleMs)})` };
  return { name: 'Chrome broker', ok: true,
    detail: `running (pid ${info.pid}, since ${new Date(info.startedAt).toISOString()}), upstream ${redactUrl(info.upstream)}, idle timeout ${minutes(info.idleMs ?? idleMs)}` };
}

export function chromeBrokerCommand(deps: { status: () => BrokerInfo | null; stop: () => Promise<boolean> }): CommandFn {
  return async (a) => {
    const sub = a.positionals[0];
    if (sub === 'status') {
      const i = deps.status();
      if (!i) return { ok: true, running: false, text: 'Chrome broker: not running' };
      // the token is a secret: never print it
      const since = new Date(i.startedAt).toISOString();
      const upstream = redactUrl(i.upstream);
      return { ok: true, running: true, pid: i.pid, port: i.port, upstream, startedAt: i.startedAt,
        text: `Chrome broker: running (pid ${i.pid}, 127.0.0.1:${i.port}, since ${since}), connected to ${upstream}` };
    }
    if (sub === 'stop') {
      const stopped = await deps.stop();
      return { ok: true, stopped, text: stopped ? 'Chrome broker stopped' : 'Chrome broker: not running' };
    }
    throw new ScreenrecError('E_BAD_ARGS', sub ? `Unknown chrome-broker subcommand "${sub}"` : 'chrome-broker needs a subcommand',
      'Usage: screenrec chrome-broker status|stop');
  };
}

export default chromeBrokerCommand({ status: () => brokerStatus(), stop: () => stopBroker() });
