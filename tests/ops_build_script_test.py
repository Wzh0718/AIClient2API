"""Exercise the real build shell workflow with fake Docker/Node and a disposable Git repo."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which('bash') if os.name != 'nt' else str(Path(shutil.which('git')).parents[1] / 'bin' / 'bash.exe')


@unittest.skipUnless(BASH and Path(BASH).exists(), 'Bash unavailable')
class BuildWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        (self.repo / 'docker').mkdir()
        (self.repo / 'docker' / 'Dockerfile.build-base').write_text('FROM fixture\n')
        (self.repo / 'package-lock.json').write_text('{}\n')
        (self.repo / 'source.txt').write_text('committed\n')
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True, capture_output=True)
        subprocess.run(['git', 'add', 'package-lock.json', 'source.txt', 'docker'], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], cwd=self.repo, check=True, capture_output=True)
        self.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.repo).decode().strip()
        (self.repo / 'source.txt').write_text('uncommitted\n')
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules' / '.package-lock.json').write_text('{}\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.make_tool('node', '''#!/usr/bin/env bash
set -eu
if [ "$1" = "--version" ]; then echo fixture-node; exit; fi
if [ "$1" = "-p" ]; then
  case "$2" in *platform*) echo fixture-platform;; *) echo "$FIXTURE_REPO/node_modules";; esac
  exit
fi
echo gate >> "$FIXTURE_LOG"
[ "$(cat source.txt)" = committed ] || exit 41
touch marker-from-tests
if [ "${FAIL_GATE:-0}" = 1 ]; then exit 42; fi
''')
        self.make_tool('docker', '''#!/usr/bin/env bash
set -eu
if [ "$1 $2" = "image inspect" ]; then
  if [ "$#" -lt 4 ]; then echo fixture-image; exit; fi
  case "$4" in
    *yyn.base_commit*) echo "$FIXTURE_COMMIT";;
    *Architecture*) echo linux/amd64;;
    *) echo sha256:fixture;;
  esac
  exit
fi
if [ "$1" = build ]; then
  echo build >> "$FIXTURE_LOG"
  context="${@: -1}"
  [ "$(cat "$context/source.txt")" = committed ] || exit 43
  [ ! -e "$context/marker-from-tests" ] || exit 44
  exit
fi
exit 45
''')
        self.env = os.environ | {'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'FIXTURE_REPO': self.repo.as_posix(), 'FIXTURE_LOG': (self.root / 'calls.log').as_posix(),
            'FIXTURE_COMMIT': self.commit, 'RELEASE_BUILD_DIR': (self.root / 'release').as_posix()}

    def make_tool(self, name, text):
        file = self.bin / name
        file.write_text(text, encoding='utf-8', newline='\n')
        file.chmod(0o755)

    def run_build(self):
        return subprocess.run([BASH, (ROOT / 'scripts' / 'ops' / 'build-image.sh').as_posix(),
                               self.commit, 'fixture:image'], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def test_exact_export_isolation_and_per_release_gate_reuse(self):
        first = self.run_build()
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        second = self.run_build()
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        calls = (self.root / 'calls.log').read_text().splitlines()
        self.assertEqual(calls.count('gate'), 1)
        self.assertEqual(calls.count('build'), 2)
        self.assertFalse((self.repo / '.git' / 'yyn-build.lock').exists())

    def test_failed_gate_prevents_build_and_is_not_cached(self):
        self.env['FAIL_GATE'] = '1'
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('build', (self.root / 'calls.log').read_text().splitlines())
        self.assertEqual(list((self.root / 'release').glob('*.ok')), [])
        self.assertFalse((self.repo / '.git' / 'yyn-build.lock').exists())

    def test_changed_installed_dependencies_invalidate_success(self):
        self.assertEqual(self.run_build().returncode, 0)
        (self.repo / 'node_modules' / '.package-lock.json').write_text('{"changed":true}')
        self.assertEqual(self.run_build().returncode, 0)
        self.assertEqual((self.root / 'calls.log').read_text().splitlines().count('gate'), 2)


if __name__ == '__main__':
    unittest.main()
