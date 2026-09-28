"""Behavior tests with disposable files and a fake Docker daemon; no live mutations."""
import copy
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
sys.path.insert(0, str(OPS))
import release
import release_backup as backup
import release_maintenance as maintenance


def healthy(epoch='old'):
    return {'status': 'healthy', 'coordination': 'redis', 'controlWorkers': 1,
            'executionWorkers': 3, 'readyWorkers': 4, 'providerConfig': {'pendingWorkerCount': 0},
            'epoch': epoch, 'persistenceBacklog': 0, 'metrics': {'inFlight': 0},
            'runtimeHooks': {'available': True, 'dropped': 0, 'backpressured': 0, 'consumerLag': 0, 'spooled': 0}}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config'
        self.config.mkdir()
        (self.config / 'provider_pools.json').write_text('{}')
        (self.config / 'test_creds.json').write_text('{"fixture":true}')
        self.files = ['provider_pools.json', 'test_creds.json']

    def test_explicit_files_only_and_roundtrip(self):
        (self.config / 'usage.sqlite').write_bytes(b'not a live database')
        (self.config / 'logs').mkdir()
        (self.config / 'logs' / 'large.log').write_bytes(b'x' * 10000)
        dest = self.root / 'snapshot'
        report = backup.snapshot(self.config, self.files, dest)
        self.assertEqual(report['fileCount'], 2)
        result = backup.finalize(dest)
        self.assertEqual(result['sha256'], backup.digest(dest / 'configs.tar.gz'))
        with tarfile.open(dest / 'configs.tar.gz') as archive:
            self.assertEqual(archive.getnames(), ['configs/' + p for p in self.files])
        with self.assertRaisesRegex(ValueError, 'already exists'):
            backup.snapshot(self.config, self.files, dest)

    def test_budget_warns_without_dropping_files(self):
        info = backup.estimate(self.config, self.files, warning_bytes=1)
        self.assertTrue(info['overBudget'])
        self.assertEqual(info['fileCount'], 2)

    def test_disallowed_paths_fail_closed(self):
        for path in ['../outside', 'usage.sqlite', 'audit.db-wal', 'request-audit/file.json',
                     'runtime-hook-spool/event.json', 'permanent-usage-ledger/day.jsonl', 'logs/foo']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                backup.inventory(self.config, [path])

    def test_changed_snapshot_cannot_be_success(self):
        dest = self.root / 'snapshot'
        backup.snapshot(self.config, self.files, dest)
        (dest / 'configs' / self.files[0]).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            backup.finalize(dest)
        self.assertFalse((dest / 'archive-verified.json').exists())

    def test_snapshot_cannot_live_inside_config(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            backup.snapshot(self.config, self.files, self.config / 'backup-new')

    def test_referenced_credentials_cannot_be_omitted(self):
        (self.config / 'provider_pools.json').write_text(json.dumps({'pool': [{'CODEX_OAUTH_CREDS_FILE_PATH': 'configs/test_creds.json'}]}))
        with self.assertRaisesRegex(ValueError, 'referenced file'):
            backup.estimate(self.config, ['provider_pools.json'])
        self.assertEqual(backup.estimate(self.config, self.files)['fileCount'], 2)


class FakeDocker:
    def __init__(self, config):
        self.calls = []
        self.fail_start = False
        self.unclean_stop = False
        self.fail_nginx = False
        self.objects = {'old': {'Id': 'old', 'Name': '/aiclient2api', 'Image': 'old-image',
            'State': {'Running': True, 'OOMKilled': False, 'ExitCode': 0, 'Health': {'Status': 'healthy'}},
            'Config': {'Env': ['FIXTURE=1'], 'Labels': {}, 'Cmd': ['node', 'server']},
            'HostConfig': {'Binds': [str(config) + ':/app/configs'], 'NetworkMode': 'test',
                           'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '13000'}]}},
            'NetworkSettings': {'Networks': {'test': {}}},
            'Mounts': [{'Source': str(config), 'Destination': '/app/configs', 'RW': True}]}}

    def lookup(self, target):
        for obj in self.objects.values():
            if target in (obj['Id'], obj['Name'].lstrip('/')):
                return obj
        raise RuntimeError('container not found')

    def __call__(self, args):
        self.calls.append(args)
        if args[:2] in (['nginx', '-t'], ['nginx', '-s']):
            if self.fail_nginx:
                raise RuntimeError('nginx invalid')
            return ''
        if args[1] == 'info':
            return 'fixture-daemon'
        if args[1:3] == ['image', 'inspect']:
            return json.dumps([{'Id': 'new-image', 'Config': {'Labels': {'yyn.base_commit': 'a' * 40}}}])
        if args[1:3] == ['container', 'inspect']:
            return json.dumps([self.lookup(args[-1])])
        if args[1] == 'create':
            role = 'candidate' if 'yyn.deployment_role=candidate' in args else 'final'
            obj = copy.deepcopy(self.objects['old'])
            obj.update(Id=role, Name='/' + args[args.index('--name') + 1], Image='new-image')
            obj['State']['Running'] = False
            obj['Config']['Labels'] = dict(args[i + 1].split('=', 1) for i, a in enumerate(args) if a == '--label')
            obj['Config']['Env'].append(args[-2])
            if role == 'candidate':
                mount = args[args.index('--volume') + 1].rsplit(':', 1)[0]
                obj['Mounts'] = [{'Source': mount, 'Destination': '/app/configs', 'RW': True}]
                obj['HostConfig']['PortBindings']['3000/tcp'][0]['HostPort'] = '13001'
            self.objects[role] = obj
            return role
        if args[1] in ('start', 'stop', 'rename'):
            obj = self.lookup(args[2] if args[1] == 'rename' else args[-1])
            if args[1] == 'start':
                if obj['Id'] == 'final' and self.fail_start:
                    raise RuntimeError('injected start failure')
                obj['State']['Running'] = True
            elif args[1] == 'stop':
                obj['State']['Running'] = False
                obj['State']['ExitCode'] = 137 if obj['Id'] == 'old' and self.unclean_stop else 0
            else:
                obj['Name'] = '/' + args[-1]
            return obj['Id']
        if args[1] == 'exec':
            return 'a' * 40
        if args[1] == 'rm':
            del self.objects[args[-1]]
            return ''
        if args[1] == 'ps':
            return ''
        if args[1:3] == ['image', 'rm']:
            return ''
        raise AssertionError(args)


class CompatibilityTests(unittest.TestCase):
    def test_only_reviewed_heap_and_revision_changes_are_allowed(self):
        old = {'HostConfig': {}, 'NetworkSettings': {'Networks': {}},
               'Config': {'Env': ['NODE_OPTIONS=--max-old-space-size=3072',
                                  'YYN_EXPECTED_REVISION=old', 'OTHER=unchanged']}}
        new = copy.deepcopy(old)
        new['Config']['Env'] = ['NODE_OPTIONS=--max-old-space-size=4096',
                                'YYN_EXPECTED_REVISION=new', 'OTHER=unchanged']
        with self.assertRaisesRegex(ValueError, 'environment drift'):
            release.compatible(old, new)
        expected = {
            'NODE_OPTIONS': {'from': '--max-old-space-size=3072', 'to': '--max-old-space-size=4096'},
            'YYN_EXPECTED_REVISION': {'from': 'old', 'to': 'new'}
        }
        release.compatible(old, new, expected)
        new['Config']['Env'][-1] = 'OTHER=changed'
        with self.assertRaisesRegex(ValueError, 'environment drift'):
            release.compatible(old, new, expected)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / 'configs'
        self.config.mkdir()
        (self.config / 'config.json').write_text('{}')
        self.nginx = self.root / 'nginx.conf'
        self.nginx.write_text('server {\n  server_name example.test;\n}\nserver {\n  server_name example.test;\n}\n')
        self.directory = self.root / 'releases' / 'release-20260924-010000'
        self.specfile = self.root / 'spec.json'
        self.spec = {'revision': 'a' * 40, 'image': 'fixture:new', 'activeContainer': 'aiclient2api',
            'databaseChange': 'none', 'expectedHost': socket.gethostname(), 'dockerId': 'fixture-daemon',
            'executionWorkers': 3, 'configDir': str(self.config), 'configFiles': ['config.json'],
            'candidateUrl': 'http://127.0.0.1:13001', 'activeUrl': 'http://127.0.0.1:13000',
            'publicUrl': 'https://example.invalid', 'nginxConfig': str(self.nginx),
            'candidateArgs': ['--volume', str(self.directory / 'candidate-snapshot' / 'configs') + ':/app/configs'],
            'finalArgs': []}
        self.specfile.write_text(json.dumps(self.spec))
        self.docker = FakeDocker(self.config)
        self.active_in_flight = 0
        self.active_spooled = 0
        self.r = release.Release(self.specfile, self.directory, self.docker, self.probe)
        self.addCleanup(patch.stopall)
        patch('release.time.sleep', lambda _: None).start()

    def probe(self, url):
        if '/runtime/health' not in url:
            return {'status': 'ok'}
        obj = self.docker.lookup('candidate' if ':13001' in url else 'aiclient2api')
        env = dict(v.split('=', 1) for v in obj['Config']['Env'])
        result = healthy(env.get('RUNTIME_DEPLOYMENT_EPOCH', 'old'))
        if ':13001' not in url:
            result['metrics']['inFlight'] = self.active_in_flight
            result['runtimeHooks']['spooled'] = self.active_spooled
        return result

    def ready(self):
        self.r.run('preflight', True)
        self.r.run('prepare', True)
        gate = maintenance.MaintenanceGate(self.r, lambda _: 503 if maintenance.MARKER in self.nginx.read_text() else 401)
        gate.arm()

    def disarm(self):
        maintenance.MaintenanceGate(self.r, lambda _: 401).disarm()

    def test_dry_run_writes_nothing(self):
        self.r.run('preflight')
        self.assertFalse(self.directory.parent.exists())
        self.assertFalse(any(c[1] in ('create', 'stop', 'start') for c in self.docker.calls))

    def test_success_keeps_old_and_defers_compression(self):
        self.ready()
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.r.run('cutover', True, True, True)
        self.assertFalse((self.directory / 'backup' / 'configs.tar.gz').exists())
        self.disarm()
        self.r.run('verify', True)
        self.assertEqual(self.r.state['phase'], 'complete')
        self.assertEqual(self.r.state['report']['businessValidation'], 'not_run')
        self.r.run('cleanup', True)
        self.assertIn('old', self.docker.objects)
        self.assertIn('final', self.docker.objects)
        self.assertNotIn('candidate', self.docker.objects)

    def test_start_failure_restores_original_by_id(self):
        self.ready()
        self.docker.fail_start = True
        with self.assertRaisesRegex(RuntimeError, 'start failure'):
            self.r.run('cutover', True, True, True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.assertEqual(self.docker.objects['old']['Name'], '/aiclient2api')
        self.assertEqual(self.r.state['phase'], 'rolled_back')
        self.assertFalse(any(c[1] == 'rm' for c in self.docker.calls))

    def test_stop_timeout_restores_old_without_snapshot(self):
        self.ready()
        self.docker.unclean_stop = True
        with self.assertRaisesRegex(ValueError, 'not clean'):
            self.r.run('cutover', True, True, True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.assertFalse((self.directory / 'backup').exists())

    def test_route_failure_before_stop_keeps_service(self):
        self.ready()
        self.docker.fail_nginx = True
        with self.assertRaisesRegex(RuntimeError, 'nginx'):
            self.r.run('cutover', True, True, True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])

    def test_phase_replay_and_unpaused_writes_refused(self):
        self.ready()
        with self.assertRaises(ValueError):
            self.r.run('prepare', True)
        with self.assertRaisesRegex(ValueError, 'pause management'):
            self.r.run('cutover', True)

    def test_invalid_name_and_migration_rejected(self):
        with self.assertRaisesRegex(ValueError, 'name'):
            release.Release(self.specfile, self.root / 'bad+0800', self.docker)
        self.spec['databaseChange'] = 'schema'
        self.specfile.write_text(json.dumps(self.spec))
        with self.assertRaisesRegex(ValueError, 'migration'):
            release.Release(self.specfile, self.directory, self.docker)

    def test_worker_and_transport_gates(self):
        for change in [{'readyWorkers': 1}, {'coordination': 'fallback'},
                       {'providerConfig': {'pendingWorkerCount': 1}}, {'runtimeHooks': {}}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.runtime_check(healthy() | change, 3)

    def test_config_drift_before_cutover(self):
        self.ready()
        self.docker.objects['final']['HostConfig']['Memory'] = 1024
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.r.run('cutover', True, True, True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])

    def test_global_lock_blocks_competing_release(self):
        with release.deployment_lock(self.directory.parent):
            with self.assertRaisesRegex(ValueError, 'lock exists'):
                self.r.run('preflight', True)

    def test_candidate_failure_never_stops_old(self):
        self.r.run('preflight', True)
        with patch.object(self.r, 'health', side_effect=RuntimeError('candidate failure')):
            with self.assertRaisesRegex(RuntimeError, 'candidate failure'):
                self.r.run('prepare', True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.assertFalse(any(c[1] == 'stop' for c in self.docker.calls))

    def test_backup_failure_keeps_verified_new_service(self):
        self.ready()
        self.r.run('cutover', True, True, True)
        self.disarm()
        with patch('release.finalize', side_effect=ValueError('archive corrupted')):
            with self.assertRaisesRegex(ValueError, 'archive corrupted'):
                self.r.run('verify', True)
        self.assertEqual(self.r.state['phase'], 'verified')
        self.assertTrue(self.docker.objects['final']['State']['Running'])
        with self.assertRaisesRegex(ValueError, 'successful service'):
            self.r.run('cleanup', True)
        self.r.run('verify', True)
        self.assertEqual(self.r.state['phase'], 'complete')

    def test_retention_only_removes_registered_oldest_recovery_point(self):
        self.ready()
        self.r.run('cutover', True, True, True)
        self.disarm()
        self.r.run('verify', True)
        unrelated = self.directory.parent / 'unrelated'
        unrelated.mkdir()
        (unrelated / 'keep.txt').write_text('keep')
        for index in [1, 2]:
            directory = self.directory.parent / ('release-old-' + str(index))
            directory.mkdir()
            backup.snapshot(self.config, ['config.json'], directory / 'backup')
            archive = backup.finalize(directory / 'backup')
            obj = copy.deepcopy(self.docker.objects['old'])
            obj.update(Id='old-' + str(index), Name='/rollback-old-' + str(index))
            self.docker.objects[obj['Id']] = obj
            record = self.r.state | {'oldId': obj['Id'], 'rollbackName': obj['Name'].lstrip('/'),
                                    'completedAt': index, 'archive': archive}
            backup.write_json(directory / 'state.json', record)
        self.r.run('cleanup', True)
        self.assertNotIn('old-1', self.docker.objects)
        self.assertIn('old-2', self.docker.objects)
        self.assertIn('old', self.docker.objects)
        self.assertFalse((self.directory.parent / 'release-old-1' / 'backup').exists())
        self.assertTrue((unrelated / 'keep.txt').exists())

    def test_missing_retained_backup_blocks_retention(self):
        self.ready()
        self.r.run('cutover', True, True, True)
        self.disarm()
        self.r.run('verify', True)
        (self.directory / 'backup' / 'configs.tar.gz').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'archive changed'):
            self.r.run('cleanup', True)
        self.assertIn('old', self.docker.objects)

    def test_maintenance_gate_is_reversible_and_validated(self):
        self.r.run('preflight', True)
        self.r.run('prepare', True)
        original = self.nginx.read_bytes()
        gate = maintenance.MaintenanceGate(self.r, lambda _: 503 if maintenance.MARKER in self.nginx.read_text() else 401)
        self.assertEqual(gate.arm()['publicApiStatus'], 503)
        self.assertTrue(self.r.state['maintenanceActive'])
        self.assertIn('if ($uri !~', self.nginx.read_text())
        gate.disarm()
        self.assertEqual(self.nginx.read_bytes(), original)
        self.assertFalse(self.r.state['maintenanceActive'])

    def test_maintenance_probe_failure_restores_nginx_without_stopping_old(self):
        self.r.run('preflight', True)
        self.r.run('prepare', True)
        before = self.nginx.read_bytes()
        gate = maintenance.MaintenanceGate(self.r, lambda _: 401)
        with self.assertRaisesRegex(ValueError, 'did not enter maintenance'):
            gate.arm()
        self.assertEqual(self.nginx.read_bytes(), before)
        self.assertTrue(self.docker.objects['old']['State']['Running'])

    def test_active_service_can_be_healthy_with_live_audit_backlog(self):
        self.r.run('preflight', True)
        self.active_spooled = 12
        result = self.r.health('old', self.spec['activeUrl'])
        self.assertEqual(result['spooled'], 12)

    def test_busy_traffic_prevents_stop_and_keeps_prepared_release(self):
        self.ready()
        self.active_in_flight = 4
        self.r.spec['drainTimeoutSeconds'] = 0
        with self.assertRaisesRegex(RuntimeError, 'inFlight=4'):
            self.r.run('cutover', True, True, True)
        self.assertEqual(self.r.state['phase'], 'prepared')
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.assertFalse(any(c[1] == 'stop' for c in self.docker.calls))

    def test_force_requires_small_inflight_and_stable_zero_persistence(self):
        self.ready()
        self.active_in_flight = 2
        now = [0]
        def wait(seconds):
            now[0] += seconds
        result = self.r.wait_for_drain(timeout=4, max_forced_in_flight=3,
                                       clock=lambda: now[0], wait=wait)
        self.assertTrue(result['forced'])
        self.assertEqual(result['inFlight'], 2)
        self.active_in_flight = 4
        now[0] = 0
        with self.assertRaisesRegex(RuntimeError, 'inFlight=4'):
            self.r.wait_for_drain(timeout=4, max_forced_in_flight=3,
                                  clock=lambda: now[0], wait=wait)
        self.active_in_flight = 1
        self.active_spooled = 1
        now[0] = 0
        with self.assertRaisesRegex(RuntimeError, 'spooled=1'):
            self.r.wait_for_drain(timeout=4, max_forced_in_flight=3,
                                  clock=lambda: now[0], wait=wait)

    def test_authorized_force_allows_non_oom_137_and_records_possible_interruptions(self):
        self.ready()
        self.docker.unclean_stop = True
        with patch.object(self.r, 'wait_for_drain', return_value={'forced': True, 'inFlight': 1,
                'backlog': 0, 'spooled': 0}):
            self.r.run('cutover', True, True, True, drain_timeout=4, max_forced_in_flight=3)
        self.disarm()
        self.r.run('verify', True)
        self.assertEqual(self.r.state['oldExit']['exitCode'], 137)
        self.assertTrue(self.r.state['report']['forcedCutover'])
        self.assertEqual(self.r.state['report']['possibleInterruptedRequestsUpperBound'], 1)

    def test_unclean_stop_without_force_still_rolls_back(self):
        self.ready()
        self.docker.unclean_stop = True
        with self.assertRaisesRegex(ValueError, 'not clean'):
            self.r.run('cutover', True, True, True, drain_timeout=4, max_forced_in_flight=0)
        self.assertTrue(self.docker.objects['old']['State']['Running'])
        self.assertEqual(self.r.state['phase'], 'rolled_back')

    def test_cutover_requires_ingress_pause(self):
        self.ready()
        with self.assertRaisesRegex(ValueError, 'pause new public API'):
            self.r.run('cutover', True, True)
        self.assertTrue(self.docker.objects['old']['State']['Running'])


if __name__ == '__main__':
    unittest.main()
