"""Resume a prepared release in one call; apply maintenance only when requested."""
import argparse
from contextlib import contextmanager
import json
import signal

from release import Release, deployment_lock, require
from release_maintenance import MaintenanceGate
from nginx_maintenance_precheck import precheck as precheck_nginx


@contextmanager
def interrupt_as_exception():
    previous = {}
    def interrupt(signum, _frame):
        raise InterruptedError('release interrupted by signal ' + str(signum))
    for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
        sig = getattr(signal, name, None)
        if sig is not None:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, interrupt)
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def advance(release, phase, apply=False, maintenance=False, status_probe=None, drain_timeout=None,
            max_forced_in_flight=0):
    release.identity()
    release.image()
    if not apply:
        return {'dryRun': True, 'requestedPhase': phase, 'currentPhase': release.state.get('phase', 'none'),
                'maintenanceRequired': phase in ('deploy', 'all')}
    with deployment_lock(release.directory.parent):
        if phase in ('prepare', 'all'):
            if not release.state:
                print('stage=preflight status=running', flush=True)
                release.run('preflight', True, lock=False)
                print('stage=preflight status=passed', flush=True)
            if release.state['phase'] == 'preflight':
                print('stage=prepare status=running', flush=True)
                release.run('prepare', True, lock=False)
                print('stage=prepare status=passed', flush=True)
            if release.state['phase'] == 'prepared' and release.spec.get('nginxMainConfig'):
                precheck_nginx(release)
        if phase in ('deploy', 'all'):
            require(maintenance, 'deployment requires explicit --maintenance mode')
            if release.state['phase'] == 'prepared':
                print('stage=candidate status=checking', flush=True)
                release.ensure_candidate()
                gate = MaintenanceGate(release, status_probe)
                print('stage=maintenance status=arming', flush=True)
                with interrupt_as_exception():
                    try:
                        gate.arm()
                        print('stage=cutover status=running', flush=True)
                        release.run('cutover', True, writes_paused=True, ingress_paused=True,
                                    lock=False, drain_timeout=drain_timeout,
                                    max_forced_in_flight=max_forced_in_flight)
                    finally:
                        if release.state.get('maintenanceActive'):
                            print('stage=maintenance status=restoring', flush=True)
                            gate.disarm()
                            print('stage=maintenance status=restored', flush=True)
            require(release.state['phase'] in ('active', 'verified', 'complete'),
                    'deployment has no active new container')
            if release.state['phase'] != 'complete':
                print('stage=verify status=running', flush=True)
                release.run('verify', True, lock=False)
                print('stage=verify status=passed', flush=True)
        return {'phase': release.state['phase'], 'revision': release.spec['revision'],
                'report': release.state.get('report'), 'timings': release.state.get('timings'),
                'interruptionSeconds': release.state.get('interruptionSeconds'),
                'possibleInterruptedRequestsUpperBound': release.state.get('interruptedRequestsUpperBound', 0)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--phase', choices=['prepare', 'deploy', 'all'], default='prepare')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--maintenance', action='store_true', help='temporary public API 503 while requests drain')
    parser.add_argument('--drain-timeout', type=int, choices=range(0,181), default=None)
    parser.add_argument('--max-forced-in-flight', type=int, choices=range(0,11), default=0)
    args = parser.parse_args()
    release = Release(args.spec, args.state_dir)
    print(json.dumps(advance(release, args.phase, args.apply, args.maintenance,
                             drain_timeout=args.drain_timeout,
                             max_forced_in_flight=args.max_forced_in_flight), ensure_ascii=False))


if __name__ == '__main__':
    main()
