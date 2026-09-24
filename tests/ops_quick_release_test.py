"""One-call recovery, ingress restoration, and profile cloning with disposable state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import ops_release_test as fixtures

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / 'ops' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


quick = load('quick_release', 'quick-release.py')
profiles = load('prepare_release_spec', 'prepare-release-spec.py')
nginx_precheck = load('nginx_precheck', 'nginx_maintenance_precheck.py')
maintenance = fixtures.maintenance


class QuickReleaseTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ReleaseTests('test_dry_run_writes_nothing')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.r = self.fixture.r
        self.nginx = self.fixture.nginx

    def probe(self, _):
        return 503 if maintenance.MARKER in self.nginx.read_text() else 401

    def test_prepare_stops_before_public_traffic_gate(self):
        result = quick.advance(self.r, 'prepare', True)
        self.assertEqual(result['phase'], 'prepared')
        self.assertNotIn(maintenance.MARKER, self.nginx.read_text())
        self.assertTrue(self.fixture.docker.objects['old']['State']['Running'])

    def test_complete_release_restores_ingress_and_preserves_old_container(self):
        original = self.nginx.read_bytes()
        result = quick.advance(self.r, 'all', True, True, self.probe)
        self.assertEqual(result['phase'], 'complete')
        self.assertEqual(self.nginx.read_bytes(), original)
        self.assertFalse(self.r.state['maintenanceActive'])
        self.assertTrue(self.fixture.docker.objects['final']['State']['Running'])
        self.assertIn('old', self.fixture.docker.objects)

    def test_busy_release_fails_before_stop_and_restores_public_ingress(self):
        quick.advance(self.r, 'prepare', True)
        self.fixture.active_in_flight = 7
        original = self.nginx.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'inFlight=7'):
            quick.advance(self.r, 'deploy', True, True, self.probe, drain_timeout=0)
        self.assertEqual(self.r.state['phase'], 'prepared')
        self.assertEqual(self.nginx.read_bytes(), original)
        self.assertTrue(self.fixture.docker.objects['old']['State']['Running'])
        self.assertFalse(any(c[1] == 'stop' for c in self.fixture.docker.calls))

    def test_identical_maintenance_evidence_can_be_reused_after_busy_abort(self):
        quick.advance(self.r, 'prepare', True)
        self.fixture.active_in_flight = 2
        with self.assertRaisesRegex(RuntimeError, 'inFlight=2'):
            quick.advance(self.r, 'deploy', True, True, self.probe, drain_timeout=0)
        self.fixture.active_in_flight = 0
        result = quick.advance(self.r, 'deploy', True, True, self.probe, drain_timeout=1)
        self.assertEqual(result['phase'], 'complete')

    def test_stop_timeout_restores_old_service_and_ingress(self):
        quick.advance(self.r, 'prepare', True)
        self.fixture.docker.unclean_stop = True
        original = self.nginx.read_bytes()
        with self.assertRaisesRegex(ValueError, 'not clean'):
            quick.advance(self.r, 'deploy', True, True, self.probe)
        self.assertEqual(self.r.state['phase'], 'rolled_back')
        self.assertEqual(self.nginx.read_bytes(), original)
        self.assertTrue(self.fixture.docker.objects['old']['State']['Running'])

    def test_deploy_requires_explicit_maintenance_switch(self):
        quick.advance(self.r, 'prepare', True)
        with self.assertRaisesRegex(ValueError, 'explicit --maintenance'):
            quick.advance(self.r, 'deploy', True)
        self.assertTrue(self.fixture.docker.objects['old']['State']['Running'])

    def test_stopped_candidate_is_restarted_before_maintenance(self):
        quick.advance(self.r, 'prepare', True)
        self.fixture.docker.objects['candidate']['State']['Running'] = False
        result = quick.advance(self.r, 'deploy', True, True, self.probe)
        self.assertEqual(result['phase'], 'complete')
        self.assertTrue(any(c[1] == 'start' and c[-1] == 'candidate' for c in self.fixture.docker.calls))


class ProfileCloneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.previous = self.root / 'previous'
        self.previous.mkdir()
        self.state = self.previous / 'state' / 'rel-old'
        self.state.mkdir(parents=True)
        self.private = self.previous / 'private'
        self.private.mkdir()
        self.env = self.private / 'runtime.env'
        self.env.write_text('FIXTURE_TOKEN=not-real\n')
        self.spec = self.private / 'spec.json'
        self.spec.write_text(json.dumps({'revision': 'a' * 40, 'image': 'old:image',
            'configFiles': ['config.json'],
            'candidateArgs': ['--env-file', str(self.env), '--volume',
                str(self.state / 'candidate-snapshot' / 'configs') + ':/app/configs'],
            'finalArgs': ['--env-file', str(self.env)]}))

    def test_private_profile_clone_updates_only_version_and_candidate_snapshot(self):
        target = self.root / 'new-release'
        preview = profiles.clone_spec(self.spec, self.state, target, 'b' * 40, 'new:image')
        self.assertFalse(target.exists())
        result = profiles.clone_spec(self.spec, self.state, target, 'b' * 40, 'new:image', True)
        self.assertEqual(result['copiedPrivateEnvFiles'], 1)
        cloned = json.loads(Path(result['newSpec']).read_text())
        self.assertEqual(cloned['revision'], 'b' * 40)
        self.assertIn(result['newStateDir'], cloned['candidateArgs'][-1])
        self.assertEqual(Path(cloned['candidateArgs'][1]).read_text(), self.env.read_text())
        self.assertEqual(cloned['candidateArgs'][1], cloned['finalArgs'][1])
        self.assertEqual(preview['newStateDir'], result['newStateDir'])

    def test_existing_target_is_never_overwritten(self):
        with self.assertRaisesRegex(ValueError, 'must not exist'):
            profiles.clone_spec(self.spec, self.state, self.previous, 'b' * 40, 'new:image', True)

    def test_nginx_preview_uses_full_main_config_and_is_reusable(self):
        site_dir = self.root / 'etc' / 'nginx' / 'conf.d'
        site_dir.mkdir(parents=True)
        site = site_dir / 'site.conf'
        site.write_text('server {\n server_name example.test;\n}\nserver {\n server_name example.test;\n}\n')
        main = site_dir.parent / 'nginx.conf'
        main.write_text('events {}\nhttp { include ' + str(site_dir / '*.conf') + '; }\n')
        class Fixture:
            spec = {'nginxConfig': str(site), 'nginxMainConfig': str(main)}
            directory = self.root / 'preview'
            state = {}
            calls = []
            def runner(self, args):
                self.calls.append(args)
            def save(self, **values):
                self.state.update(values)
        fixture = Fixture()
        fixture.directory.mkdir()
        first = nginx_precheck.precheck(fixture)
        second = nginx_precheck.precheck(fixture)
        self.assertEqual(first['guardedServers'], 2)
        self.assertTrue(second['reused'])
        self.assertEqual(len(fixture.calls), 1)
        self.assertEqual(fixture.calls[0][:3], ['nginx', '-t', '-c'])
        self.assertEqual(site.read_text().count('server_name'), 2)


if __name__ == '__main__':
    unittest.main()
