"""Single-writer release phases. Dry-run by default; requires an explicit private spec."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import urllib.parse

from release_backup import digest, estimate, snapshot, finalize, write_json

PHASES = ('preflight', 'prepare', 'cutover', 'verify', 'rollback', 'cleanup')
NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]+$')
FLAGS = {'--network', '--env', '--env-file', '--mount', '--volume', '--publish',
         '--log-driver', '--log-opt', '--cpus', '--memory', '--restart', '--add-host',
         '--ulimit', '--user', '--workdir', '--stop-timeout', '--shm-size'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def checked_args(args):
    require(isinstance(args, list) and len(args) % 2 == 0, 'create args must be flag/value pairs')
    for flag, value in zip(args[::2], args[1::2]):
        require(flag in FLAGS and isinstance(value, str) and '\x00' not in value,
                'unsupported create flag/value; names, labels and image are owned by release tool')
    return args


def runtime_check(value, workers, epoch=None):
    require(value.get('status') == 'healthy', 'runtime is not healthy')
    require(value.get('coordination') == 'redis', 'Redis multi-worker coordination required')
    require(value.get('controlWorkers') == 1 and value.get('executionWorkers') == workers
            and value.get('readyWorkers') == workers + 1, 'incomplete worker topology')
    require(value.get('providerConfig', {}).get('pendingWorkerCount') == 0,
            'provider config has pending workers')
    if epoch:
        require(value.get('epoch') == epoch, 'deployment epoch mismatch')
    hooks = value.get('runtimeHooks', {})
    require(hooks.get('available') is True, 'runtime hook transport unavailable or missing')
    for key in ('dropped', 'backpressured', 'consumerLag'):
        require(hooks.get(key) == 0, 'runtime hook errors: ' + key)
    require(isinstance(value.get('persistenceBacklog'), (int, float)), 'missing persistence backlog')
    require(isinstance(hooks.get('spooled'), (int, float)), 'missing spool metric')
    return {'backlog': value['persistenceBacklog'], 'spooled': hooks['spooled']}


def compatible(old, new):
    # Compare the actual pre-created container, not just CLI text. Unsupported
    # changes fail before stopping anything; deployment is not a topology editor.
    for key in ('PortBindings', 'Binds', 'Mounts', 'NetworkMode', 'RestartPolicy',
                'LogConfig', 'Memory', 'NanoCpus', 'ExtraHosts', 'Privileged',
                'CapAdd', 'CapDrop', 'SecurityOpt', 'ReadonlyRootfs', 'Dns',
                'Ulimits', 'Devices', 'PidMode', 'IpcMode', 'ShmSize', 'Init'):
        require(old['HostConfig'].get(key) == new['HostConfig'].get(key), 'container setting drift: ' + key)
    for key in ('User', 'WorkingDir', 'Entrypoint', 'Cmd'):
        require(old['Config'].get(key) == new['Config'].get(key), 'container command drift: ' + key)
    def env(container):
        return dict(s.split('=', 1) for s in container['Config'].get('Env', [])
                    if not s.startswith('RUNTIME_DEPLOYMENT_EPOCH='))
    require(env(old) == env(new), 'container environment drift; review the spec before cutover')
    require(set(old.get('NetworkSettings', {}).get('Networks', {})) ==
            set(new.get('NetworkSettings', {}).get('Networks', {})), 'container network drift')


class Release:
    def __init__(self, spec_path, directory, runner=None, probe=None):
        self.spec_path = Path(spec_path).resolve()
        self.spec = json.loads(self.spec_path.read_text(encoding='utf-8'))
        self.directory = Path(directory).resolve()
        self.runner = runner or self.command
        self.probe = probe or self.http
        self.state = {}
        self.validate_spec()
        if (self.directory / 'state.json').exists():
            self.state = json.loads((self.directory / 'state.json').read_text(encoding='utf-8'))
            require(self.state['specHash'] == self.spec_hash(), 'release spec or env file changed; use a new release')

    def validate_spec(self):
        s = self.spec
        require(re.fullmatch(r'[0-9a-f]{40}', s['revision']), 'full commit SHA required')
        require(NAME.fullmatch(s['activeContainer']), 'invalid active container name')
        require(NAME.fullmatch(self.directory.name), 'invalid release directory/name (no +timezone)')
        require(s.get('databaseChange') == 'none', 'database migration requires a separate recovery plan')
        require(s.get('expectedHost') and s.get('dockerId'), 'explicit host and Docker daemon identity required')
        require(isinstance(s.get('executionWorkers'), int) and s['executionWorkers'] > 0, 'executionWorkers required')
        require(Path(s['configDir']).is_absolute(), 'configDir must be absolute')
        config = Path(s['configDir']).resolve()
        require(self.directory != config and config not in self.directory.parents, 'release state must be outside configs')
        for key in ('candidateArgs', 'finalArgs'):
            checked_args(s[key])
        require(s['candidateUrl'].startswith('http://127.0.0.1:'), 'candidate must bind loopback')
        require(s['activeUrl'].startswith('http://127.0.0.1:'), 'active probe must use loopback')
        require(s['publicUrl'].startswith('https://'), 'public probe requires HTTPS')
        require(Path(s['nginxConfig']).is_absolute(), 'explicit unchanged Nginx config required')

    def spec_hash(self):
        h = hashlib.sha256(self.spec_path.read_bytes())
        for key in ('candidateArgs', 'finalArgs'):
            for flag, value in zip(self.spec[key][::2], self.spec[key][1::2]):
                if flag == '--env-file':
                    h.update(Path(value).read_bytes())
        return h.hexdigest()

    def command(self, args, timeout=180):
        # Never echo args/inspect/env values; even Docker errors may contain secrets.
        started = time.monotonic()
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if self.directory.exists():
            with (self.directory / 'commands.jsonl').open('a', encoding='utf-8') as log:
                log.write(json.dumps({'tool': args[0], 'verb': args[1] if len(args) > 1 else '',
                                      'seconds': round(time.monotonic() - started, 3), 'exitCode': result.returncode}) + '\n')
        if result.returncode:
            if self.directory.exists():
                path = self.directory / 'last-error.private.txt'
                path.write_text(result.stderr, encoding='utf-8')
                os.chmod(path, 0o600)
            raise RuntimeError('command failed: ' + args[0] + ' (see protected diagnostics)')
        return result.stdout.strip()

    @staticmethod
    def http(url):
        with urllib.request.urlopen(url, timeout=10) as response:
            return json.load(response)

    def inspect(self, target):
        return json.loads(self.runner(['docker', 'container', 'inspect', target]))[0]

    def save(self, **values):
        self.state.update(values)
        write_json(self.directory / 'state.json', self.state)

    def identity(self):
        require(socket.gethostname() == self.spec['expectedHost'], 'target host mismatch')
        require(self.runner(['docker', 'info', '--format', '{{.ID}}']) == self.spec['dockerId'], 'Docker daemon mismatch')

    def image(self):
        image = json.loads(self.runner(['docker', 'image', 'inspect', self.spec['image']]))[0]
        require(image['Config'].get('Labels', {}).get('yyn.base_commit') == self.spec['revision'], 'image revision mismatch')
        if self.state.get('imageId'):
            require(self.state['imageId'] == image['Id'], 'image tag moved')
        return image['Id']

    def health(self, container, url, epoch=None, timeout=180):
        deadline = time.monotonic() + timeout
        previous = None
        while True:
            try:
                obj = self.inspect(container)
                require(obj['State'].get('Running') and not obj['State'].get('OOMKilled'), 'container not running or OOM')
                require(obj['State'].get('Health', {}).get('Status') == 'healthy', 'Docker health not ready')
                require(obj.get('RestartCount', 0) == 0, 'container restarted')
                self.probe(url + '/api/health')
                value = self.probe(url + '/runtime/health')
                metrics = runtime_check(value, self.spec['executionWorkers'], epoch)
                if previous is not None and metrics['spooled'] == 0 and metrics['backlog'] <= previous:
                    return metrics
                previous = metrics['backlog']
            except (ValueError, OSError, RuntimeError):
                previous = None
            if time.monotonic() >= deadline:
                raise RuntimeError('health/topology/backlog did not converge before deadline')
            time.sleep(2)

    def preflight(self):
        require(not self.state, 'preflight already recorded; use its next phase')
        old = self.inspect(self.spec['activeContainer'])
        require(old['State']['Running'], 'old container is not running')
        self.health(old['Id'], self.spec['activeUrl'])
        require(any(m['Source'] == self.spec['configDir'] and m['Destination'] == '/app/configs'
                    and m.get('RW') for m in old['Mounts']), 'canonical config bind mismatch')
        self.runner(['nginx', '-t'])
        estimate_result = estimate(self.spec['configDir'], self.spec['configFiles'])
        self.directory.mkdir(mode=0o700)
        os.chmod(self.directory, 0o700)
        write_json(self.directory / 'old-inspect.private.json', old)
        shutil.copyfile(self.spec['nginxConfig'], self.directory / 'nginx-before.private.conf')
        os.chmod(self.directory / 'nginx-before.private.conf', 0o600)
        name = self.directory.name
        self.save(kind='aiclient-release-v1', specHash=self.spec_hash(), phase='preflight',
                  dockerId=self.spec['dockerId'], expectedHost=self.spec['expectedHost'],
                  imageId=self.image(), oldId=old['Id'], oldImage=old['Image'],
                  activeName=self.spec['activeContainer'], rollbackName=self.spec['activeContainer'] + '-rollback-' + name,
                  candidateName='candidate-' + name, finalName='final-' + name,
                  epoch='green-' + name, candidateEpoch='candidate-' + name,
                  nginxHash=digest(self.spec['nginxConfig']), backupEstimate=estimate_result,
                  report={'codeValidation': 'not_recorded', 'imageBuild': 'revision_verified',
                          'localRuntime': 'not_recorded', 'productionRuntime': 'pending',
                          'businessValidation': 'not_run', 'gitPush': 'not_recorded'})

    def owned(self, container_id, role):
        obj = self.inspect(container_id)
        labels = obj['Config'].get('Labels', {})
        require(labels.get('yyn.release_id') == self.directory.name and
                labels.get('yyn.deployment_role') == role, 'unowned release container')
        require(obj['Image'] == self.state['imageId'], 'container image mismatch')
        return obj

    def create(self, role, args):
        name = self.state['candidateName' if role == 'candidate' else 'finalName']
        epoch = self.state['candidateEpoch' if role == 'candidate' else 'epoch']
        obj = self.runner(['docker', 'create', '--name', name,
                           '--label', 'yyn.release_id=' + self.directory.name,
                           '--label', 'yyn.deployment_role=' + role,
                           *args, '--env', 'RUNTIME_DEPLOYMENT_EPOCH=' + epoch, self.state['imageId']])
        self.save(**{role + 'Id': obj})
        return self.owned(obj, role)

    def prepare(self):
        require(self.state['phase'] == 'preflight', 'prepare requires preflight')
        require(not self.state.get('candidateId') and not self.state.get('finalId'),
                'partial prepare exists; inspect and clean up owned containers before a new release')
        self.save(phase='preparing')
        snapshot(self.spec['configDir'], self.spec['configFiles'], self.directory / 'candidate-snapshot')
        candidate = self.create('candidate', self.spec['candidateArgs'])
        expected = str(self.directory / 'candidate-snapshot' / 'configs')
        require(any(m['Source'] == expected and m['Destination'] == '/app/configs' for m in candidate['Mounts']),
                'candidate must mount its isolated snapshot')
        for m in candidate['Mounts']:
            source = Path(m['Source']).resolve()
            isolated = Path(expected).resolve()
            require(not m.get('RW') or source == isolated or isolated in source.parents,
                    'candidate writable mounts must stay inside its isolated config snapshot')
        bindings = candidate['HostConfig'].get('PortBindings', {})
        port = str(urllib.parse.urlparse(self.spec['candidateUrl']).port)
        require(bindings == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': port}]}, 'candidate must publish only loopback API')
        self.runner(['docker', 'start', candidate['Id']])
        self.health(candidate['Id'], self.spec['candidateUrl'], self.state['candidateEpoch'])
        final = self.create('final', self.spec['finalArgs'])
        compatible(self.inspect(self.state['oldId']), final)
        require(not final['State']['Running'], 'precreated final must not run')
        self.save(phase='prepared')

    def cutover(self, writes_paused=False):
        require(self.state['phase'] == 'prepared', 'cutover requires prepared state')
        require(writes_paused, 'pause management/OAuth writes before --writes-paused')
        require(self.inspect(self.spec['activeContainer'])['Id'] == self.state['oldId'], 'active container changed')
        require(digest(self.spec['nginxConfig']) == self.state['nginxHash'], 'Nginx config changed')
        self.runner(['nginx', '-t'])
        self.health(self.state['candidateId'], self.spec['candidateUrl'], self.state['candidateEpoch'])
        self.health(self.state['oldId'], self.spec['activeUrl'])
        compatible(self.inspect(self.state['oldId']), self.owned(self.state['finalId'], 'final'))
        self.save(phase='cutover')
        # Each mutation is a distinct argv call. Old objects are never deleted here.
        self.runner(['docker', 'stop', '--time', '120', self.state['candidateId']])
        self.save(cutoverStarted=time.time())
        self.runner(['docker', 'stop', '--time', '120', self.state['oldId']])
        stopped = self.inspect(self.state['oldId'])
        self.save(oldExit={'exitCode': stopped['State']['ExitCode'], 'oomKilled': stopped['State']['OOMKilled']})
        require(not stopped['State']['Running'], 'old writer has not stopped')
        require(stopped['State']['ExitCode'] == 0 and not stopped['State']['OOMKilled'],
                'old shutdown was not clean; restore old service and investigate drain/spool')
        snapshot(self.spec['configDir'], self.spec['configFiles'], self.directory / 'backup')
        self.runner(['docker', 'rename', self.state['oldId'], self.state['rollbackName']])
        self.runner(['docker', 'rename', self.state['finalId'], self.spec['activeContainer']])
        self.runner(['docker', 'start', self.state['finalId']])
        self.health(self.state['finalId'], self.spec['activeUrl'], self.state['epoch'])
        self.save(phase='active', interruptionSeconds=round(time.time() - self.state['cutoverStarted'], 3))

    def verify(self):
        require(self.state['phase'] in ('active', 'verified'), 'verify requires active state')
        require(self.inspect(self.spec['activeContainer'])['Id'] == self.state['finalId'], 'active identity changed')
        self.owned(self.state['finalId'], 'final')
        revision = self.runner(['docker', 'exec', self.state['finalId'], 'cat', '/app/REVISION'])
        require(revision == self.spec['revision'], 'active source revision mismatch')
        metrics = self.health(self.state['finalId'], self.spec['activeUrl'], self.state['epoch'])
        self.probe(self.spec['publicUrl'] + '/api/health')
        runtime_check(self.probe(self.spec['publicUrl'] + '/runtime/health'), self.spec['executionWorkers'], self.state['epoch'])
        require(digest(self.spec['nginxConfig']) == self.state['nginxHash'], 'Nginx config changed')
        self.runner(['nginx', '-t'])
        # Mark service validation before compression. A backup error should leave
        # the healthy active service in place and retain all recovery objects.
        self.save(phase='verified', runtimeMetrics=metrics)
        archive = finalize(self.directory / 'backup')
        report = self.state['report'] | {'productionRuntime': 'passed', 'businessValidation': 'not_run'}
        self.save(phase='complete', completedAt=time.time(), archive=archive, report=report)

    def rollback(self):
        require(self.state.get('oldId'), 'no original container recorded')
        require(not self.state.get('retired'), 'this recovery point has been retired')
        old = self.inspect(self.state['oldId'])  # Must exist before stopping the new service.
        require(old['Image'] == self.state['oldImage'], 'old image changed')
        if self.state.get('finalId'):
            new = self.owned(self.state['finalId'], 'final')
            if new['State']['Running']:
                self.runner(['docker', 'stop', '--time', '120', new['Id']])
            require(not self.inspect(new['Id'])['State']['Running'], 'new writer still running')
            if new['Name'].lstrip('/') == self.spec['activeContainer']:
                self.runner(['docker', 'rename', new['Id'], self.state['finalName']])
        if old['Name'].lstrip('/') != self.spec['activeContainer']:
            self.runner(['docker', 'rename', old['Id'], self.spec['activeContainer']])
        if not old['State']['Running']:
            self.runner(['docker', 'start', old['Id']])
        # This workflow keeps the same upstream/ports and never overwrites configs
        # or Nginx. Unexpected external route changes need manual reconciliation.
        require(digest(self.spec['nginxConfig']) == self.state['nginxHash'], 'service restored; external Nginx drift needs review')
        self.runner(['nginx', '-t'])
        self.health(old['Id'], self.spec['activeUrl'])
        self.save(phase='rolled_back', rolledBackAt=time.time())

    def cleanup(self):
        require(self.state['phase'] == 'complete', 'cleanup requires successful service and archive verification')
        require(digest(self.directory / 'backup' / 'configs.tar.gz') == self.state['archive']['sha256'], 'backup archive changed')
        require(self.inspect(self.spec['activeContainer'])['Id'] == self.state['finalId'], 'cleanup must run from current release')
        if self.state.get('candidateId'):
            obj = self.owned(self.state['candidateId'], 'candidate')
            require(not obj['State']['Running'], 'candidate still running')
            self.runner(['docker', 'rm', obj['Id']])
            self.save(candidateId=None)
        # Retain two completed, compatible release records. Never prune arbitrary
        # Docker objects or legacy backup folders lacking an ownership record.
        records = []
        for path in self.directory.parent.glob('*/state.json'):
            record = json.loads(path.read_text(encoding='utf-8'))
            if (record.get('kind') == 'aiclient-release-v1' and record.get('phase') == 'complete'
                    and record.get('activeName') == self.spec['activeContainer']
                    and record.get('dockerId') == self.spec['dockerId'] and not record.get('retired')):
                records.append((record['completedAt'], path.parent, record))
        for _, directory, record in sorted(records, reverse=True)[:2]:
            require(digest(directory / 'backup' / 'configs.tar.gz') == record['archive']['sha256'],
                    'retained backup is missing or corrupt; refusing retention cleanup')
        for _, directory, record in sorted(records, reverse=True)[2:]:
            if not record.get('oldContainerRemoved'):
                old = self.inspect(record['oldId'])
                require(not old['State']['Running'] and old['Image'] == record['oldImage']
                        and old['Name'].lstrip('/') == record['rollbackName'], 'retention target drift')
                self.runner(['docker', 'rm', record['oldId']])
                record['oldContainerRemoved'] = True
                write_json(directory / 'state.json', record)
            # Docker refuses removing an image used by another container; only
            # attempt rmi when no container references the recorded exact ID.
            refs = self.runner(['docker', 'ps', '-aq', '--filter', 'ancestor=' + record['oldImage']])
            if not refs and record['oldImage'] != self.state['imageId']:
                try:
                    self.runner(['docker', 'image', 'rm', record['oldImage']])
                    record['oldImageCleanup'] = 'removed'
                except RuntimeError:
                    record['oldImageCleanup'] = 'retained_requires_review'
                    self.save(cleanupWarnings=self.state.get('cleanupWarnings', []) +
                              ['retained image requires review: ' + record['oldImage']])
            for child in ('backup', 'candidate-snapshot'):
                target = directory / child
                require(not target.is_symlink() and target.resolve().parent == directory.resolve(), 'unsafe cleanup path')
                if target.exists():
                    shutil.rmtree(target)
            record['retired'] = True
            write_json(directory / 'state.json', record)

    def run(self, phase, apply=False, writes_paused=False):
        self.identity()
        self.image()
        if not apply:
            return {'dryRun': True, 'phase': phase, 'revision': self.spec['revision'],
                    'backup': estimate(self.spec['configDir'], self.spec['configFiles']),
                    'recordedPhase': self.state.get('phase', 'none')}
        with deployment_lock(self.directory.parent):
            state_path = self.directory / 'state.json'
            if state_path.exists():
                require(json.loads(state_path.read_text(encoding='utf-8')) == self.state,
                        'release state changed after load; inspect and retry')
            started = time.monotonic()
            try:
                if phase == 'cutover':
                    self.cutover(writes_paused)
                else:
                    getattr(self, phase)()
            except Exception:
                if self.state.get('phase') in ('cutover', 'active'):
                    try:
                        self.rollback()
                    except Exception:
                        self.save(recovery='manual_attention_required')
                raise
            finally:
                if self.state:
                    timings = self.state.get('timings', {})
                    timings[phase] = round(time.monotonic() - started, 3)
                    self.save(timings=timings)
        return {'phase': self.state['phase'], 'report': self.state.get('report'), 'timings': self.state.get('timings'),
                'cleanupWarnings': self.state.get('cleanupWarnings', [])}


@contextmanager
def deployment_lock(parent):
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = parent / '.deploy.lock'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise ValueError('deployment lock exists; inspect owner before manual recovery')
    try:
        write_json(lock / 'owner.json', {'pid': os.getpid(), 'host': socket.gethostname(), 'time': time.time()})
        yield
    finally:
        (lock / 'owner.json').unlink(missing_ok=True)
        lock.rmdir()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--phase', choices=PHASES, default='preflight')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--writes-paused', action='store_true')
    args = parser.parse_args()
    release = Release(args.spec, args.state_dir)
    print(json.dumps(release.run(args.phase, args.apply, args.writes_paused), ensure_ascii=False))


if __name__ == '__main__':
    main()
